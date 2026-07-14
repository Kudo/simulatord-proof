#!/usr/bin/env bun
// ============================================================================
// simulatord CLUSTER proof (TypeScript / Bun) — self-contained.
//
// Boots a whole cluster on localhost from the prebuilt binaries in ./bin:
//   coordinator : simd-coordinator, static fleet of three workers
//   w1, w2      : two simulatord daemons (distinct addr / state / label)
//   ghost       : listed in the fleet but never started — must show up down
//
// The client only ever talks to the coordinator (gateway model):
//   create (keyed) → replay same key (same session back, no second boot)
//   → aggregated list (globalized ids + unreachable ghost)
//   → screenshot (raw pass-through) → freeze → resume → shutdown.
//
// No simulatord source is needed to run this — just the binaries + Bun +
// Xcode simulators on the host. Run: bun cluster.ts
// ============================================================================

import { mkdir, rm, writeFile } from "node:fs/promises";

// These mirror the simulatord wire protocol (JSON over HTTP). Kept as loose
// aliases so this proof carries no generated types from the source repo.
type Request = any;
type Response = any;
type FleetView = any;

const ROOT = import.meta.dir;
const BIN = process.env.SIMD_BIN ?? `${ROOT}/bin`;
const OUT = process.env.SIMD_OUT ?? `${ROOT}/out`;
const COORD_ADDR = "127.0.0.1:8700";
const COORD_URL = `http://${COORD_ADDR}`;
const COORD_TOKEN = "proof-coord-token";
const W1_TOKEN = "proof-w1-token";

// The simulator to boot. Defaults suit a machine with iOS 26 installed; on a
// CI runner the workflow discovers the newest available runtime + device type
// and passes them via these env vars.
const DEVICE_TYPE = process.env.SIMD_DEVICE_TYPE ?? "iPhone 16 Pro";
const RUNTIME = process.env.SIMD_RUNTIME ?? "com.apple.CoreSimulator.SimRuntime.iOS-26-5";

// A session is scoped to one app. Default to the public Expo Go archive URL so
// the run also exercises URL delivery + the worker's app cache.
const APP =
  process.env.SIMD_APP ??
  "https://github.com/expo/expo-go-releases/releases/download/Expo-Go-57.0.2/Expo-Go-57.0.2.tar.gz";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(`\n========== ${s} ==========`);

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

// ---- coordinator client: same typed protocol as a single daemon ----
async function send(request: Request): Promise<Response> {
  const res = await fetch(`${COORD_URL}/v1/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${COORD_TOKEN}`,
    },
    body: JSON.stringify(request),
  });
  return (await res.json()) as Response;
}

function expect(response: Response, status: string, context: string): Response {
  if (response.status !== status) {
    fail(`${context}: expected ${status}, got ${JSON.stringify(response)}`);
  }
  return response;
}

// ---- process orchestration ----
const children: Bun.Subprocess[] = [];

function spawn(name: string, cmd: string[], env: Record<string, string>) {
  const child = Bun.spawn(cmd, {
    env: { ...process.env, ...env },
    stdout: Bun.file(`${OUT}/${name}.log`),
    stderr: Bun.file(`${OUT}/${name}.log`),
  });
  children.push(child);
  return child;
}

async function waitHealthy(url: string, name: string) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {}
    await sleep(500);
  }
  fail(`${name} never became healthy at ${url}`);
}

function shutdownAll() {
  for (const child of children) child.kill();
}
process.on("exit", shutdownAll);

// ============================================================================
async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  console.log(`device_type=${DEVICE_TYPE}  runtime=${RUNTIME}`);

  log("start two workers + coordinator (ghost stays dead)");
  const fleetPath = `${OUT}/fleet.toml`;
  await writeFile(
    fleetPath,
    `
[[worker]]
label = "w1"
url = "http://127.0.0.1:8711"
token = "${W1_TOKEN}"

[[worker]]
label = "w2"
url = "http://127.0.0.1:8712"

[[worker]]
label = "ghost"
url = "http://127.0.0.1:8790"
`,
  );
  spawn("w1", [`${BIN}/simulatord`], {
    SIMD_ADDR: "127.0.0.1:8711",
    SIMD_TOKEN: W1_TOKEN,
    SIMD_LABEL: "w1",
    SIMD_STATE: `${OUT}/w1-state.json`,
  });
  spawn("w2", [`${BIN}/simulatord`], {
    SIMD_ADDR: "127.0.0.1:8712",
    SIMD_LABEL: "w2",
    SIMD_STATE: `${OUT}/w2-state.json`,
  });
  await waitHealthy("http://127.0.0.1:8711", "w1");
  await waitHealthy("http://127.0.0.1:8712", "w2");
  spawn("coordinator", [`${BIN}/simd-coordinator`], {
    SIMD_COORD_ADDR: COORD_ADDR,
    SIMD_COORD_TOKEN: COORD_TOKEN,
    SIMD_FLEET: fleetPath,
    SIMD_POLL_SECS: "1",
  });
  await waitHealthy(COORD_URL, "coordinator");
  await sleep(2500); // a couple of polls so w1/w2 are proven up

  log("fleet: w1+w2 up, ghost down");
  const fleet = (await (
    await fetch(`${COORD_URL}/fleet`, {
      headers: { authorization: `Bearer ${COORD_TOKEN}` },
    })
  ).json()) as FleetView;
  for (const [label, up] of [
    ["w1", true],
    ["w2", true],
    ["ghost", false],
  ] as const) {
    const w = fleet.workers.find((w: any) => w.label === label);
    if (!w || w.up !== up) fail(`fleet: expected ${label} up=${up}, got ${JSON.stringify(w)}`);
  }
  console.log("fleet view ok");

  log("create through the coordinator (keyed; boots a real sim)");
  const key = `cluster-proof-${Date.now()}`;
  const createParams = {
    name: "cluster-proof",
    device_type: DEVICE_TYPE,
    runtime: RUNTIME,
    app: APP,
    hibernate_secs: null,
    cool_secs: null,
    purge_secs: null,
    idempotency_key: key,
  };
  const created = expect(
    await send({ method: "create", params: createParams }),
    "created",
    "create",
  );
  const sid = created.id;
  if (!/^(w1|w2)-s\d+$/.test(sid)) fail(`create: id '${sid}' is not a global id`);
  console.log(`created ${sid} (${created.udid})`);

  log("replay the same key — must return the SAME session, instantly");
  const t0 = Date.now();
  const replay = expect(
    await send({ method: "create", params: createParams }),
    "created",
    "replay",
  );
  const replayMs = Date.now() - t0;
  if (replay.id !== sid || replay.udid !== created.udid) {
    fail(`replay: got ${replay.id}/${replay.udid}, want ${sid}/${created.udid}`);
  }
  if (replayMs > 5000) fail(`replay took ${replayMs}ms — that's a second boot, not a dedupe`);
  console.log(`replay returned ${sid} in ${replayMs}ms`);

  log("aggregated list: globalized ids + unreachable ghost");
  const list = expect(await send({ method: "list" }), "list", "list");
  if (!list.sessions.some((s: any) => s.id === sid)) {
    fail(`list: ${sid} missing from ${JSON.stringify(list.sessions)}`);
  }
  if (!list.unreachable_workers.includes("ghost")) {
    fail(`list: ghost missing from unreachable_workers ${JSON.stringify(list.unreachable_workers)}`);
  }
  console.log(`list ok: ${list.sessions.length} session(s), unreachable=${list.unreachable_workers}`);

  log("screenshot through the pass-through relay");
  const shot = expect(
    await send({ method: "screenshot", params: { session: sid } }),
    "screenshot",
    "screenshot",
  );
  const png = Buffer.from(shot.png_base64, "base64");
  if (png.length < 1000 || png.readUInt32BE(0) !== 0x89504e47) {
    fail(`screenshot: not a PNG (${png.length} bytes)`);
  }
  await writeFile(`${OUT}/${sid}.png`, png);
  console.log(`screenshot ok (${png.length} bytes) -> ${OUT}/${sid}.png`);

  log("freeze → resume through the cluster (hibernation tier ride-along)");
  expect(await send({ method: "freeze", params: { session: sid } }), "ok", "freeze");
  expect(await send({ method: "resume", params: { session: sid } }), "ok", "resume");
  console.log("freeze/resume ok");

  log("shutdown; list must be empty again");
  expect(await send({ method: "shutdown", params: { session: sid } }), "ok", "shutdown");
  const after = expect(await send({ method: "list" }), "list", "final list");
  if (after.sessions.length !== 0) {
    fail(`final list not empty: ${JSON.stringify(after.sessions)}`);
  }
  console.log("shutdown ok, no sessions left");

  log("CLUSTER PROOF PASSED");
  shutdownAll();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  shutdownAll();
  process.exit(1);
});
