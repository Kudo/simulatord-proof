#!/usr/bin/env bun
// ============================================================================
// LOCAL client — runs on your machine, drives a REMOTE simulatord cluster.
//
// The coordinator + workers live on a GitHub Actions macOS runner, reachable
// through a cloudflared tunnel. This client is pure HTTP (no local xcrun / no
// simulator), so it needs only Bun + the tunnel URL.
//
// Flow: keyed create (instant replay of the job's warm-up — the sim is already
// booted with Expo Go) → relaunch (a real client-driven app launch on the
// remote sim) → screenshot (saved locally). "Launch + screenshot" against a
// cloud fleet, driven from here.
//
// Env (all published by the workflow's `conn` artifact):
//   SIMD_URL, SIMD_TOKEN, SIMD_DEVICE_TYPE, SIMD_RUNTIME, SIMD_APP, SIMD_KEY
//   SIMD_OUT (optional; where to write screenshots — default ./local-out)
// ============================================================================

import { mkdir, writeFile } from "node:fs/promises";

const URL = requireEnv("SIMD_URL");
const TOKEN = requireEnv("SIMD_TOKEN");
const DEVICE_TYPE = requireEnv("SIMD_DEVICE_TYPE");
const RUNTIME = requireEnv("SIMD_RUNTIME");
const APP = requireEnv("SIMD_APP");
const KEY = requireEnv("SIMD_KEY");
const OUT = process.env.SIMD_OUT ?? `${import.meta.dir}/local-out`;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env ${name} (get it from the workflow's conn artifact)`);
    process.exit(1);
  }
  return v;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(`\n========== ${s} ==========`);
function fail(m: string): never {
  console.error(`FAIL: ${m}`);
  process.exit(1);
}

async function send(request: any): Promise<any> {
  const res = await fetch(`${URL}/v1/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(request),
  });
  return (await res.json()) as any;
}
function expect(response: any, status: string, context: string): any {
  if (response?.status !== status) fail(`${context}: expected ${status}, got ${JSON.stringify(response)}`);
  return response;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  console.log(`coordinator: ${URL}`);
  console.log(`device=${DEVICE_TYPE} runtime=${RUNTIME}`);

  log("keyed create — replays the job's warm-up session instantly");
  const t0 = Date.now();
  const created = expect(
    await send({
      method: "create",
      params: {
        name: "interact",
        device_type: DEVICE_TYPE,
        runtime: RUNTIME,
        app: APP,
        hibernate_secs: null,
        cool_secs: null,
        purge_secs: null,
        idempotency_key: KEY,
      },
    }),
    "created",
    "create",
  );
  const sid = created.id;
  console.log(`session ${sid} (${created.udid}) in ${Date.now() - t0}ms`);

  log("relaunch Expo Go on the remote sim (client-driven launch)");
  expect(await send({ method: "relaunch", params: { session: sid } }), "ok", "relaunch");
  await sleep(4000); // let Expo Go render

  log("screenshot the remote sim → save locally");
  const shot = expect(await send({ method: "screenshot", params: { session: sid } }), "screenshot", "screenshot");
  const png = Buffer.from(shot.png_base64, "base64");
  if (png.length < 1000 || png.readUInt32BE(0) !== 0x89504e47) fail(`not a PNG (${png.length} bytes)`);
  const path = `${OUT}/${sid}-expo-go.png`;
  await writeFile(path, png);
  console.log(`screenshot ok (${png.length} bytes) -> ${path}`);

  log("REMOTE DRIVE OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
