# simulatord cluster — proof of life

A **source-free** demonstration that the [simulatord](https://github.com/) cluster
works on a clean, ephemeral cloud macOS host — not just "on my machine."

This repo ships only:

- `bin/` — the prebuilt `simulatord` (worker daemon) and `simd-coordinator`
  binaries (arm64 macOS, min macOS 13, ad-hoc signed).
- `cluster.ts` — a small [Bun](https://bun.sh) client that boots the whole
  fleet and drives it end-to-end.
- `.github/workflows/proof.yml` — runs it on a GitHub-hosted macOS runner.

No Rust source, no build step.

## What it proves

One macOS job starts a **coordinator + two worker daemons** on localhost (plus a
never-started "ghost" worker), then, talking *only* to the coordinator gateway:

1. **create** a session with an idempotency key → boots a real iOS simulator and
   installs Expo Go (fetched from a public URL — exercises URL app delivery + the
   worker's app cache).
2. **replay** the same key → returns the *same* session instantly (no second
   boot) — idempotent create.
3. **aggregated list** → session ids are globalized (`w1-s1`), and the dead
   ghost shows up under `unreachable_workers`.
4. **screenshot** relayed through the coordinator's raw pass-through.
5. **freeze → resume** → the hibernation tier, driven through the cluster.
6. **shutdown** → no sessions or simulator devices left behind.

Green run + `CLUSTER PROOF PASSED` = placement, routing, idempotency, aggregation,
screenshot relay, and hibernation all work on a fresh cloud Mac.

This proves **correctness**, not performance — hibernation density/latency
targets need a real host under memory pressure, not a shared CI runner.

## Run it

Push to GitHub, then **Actions → proof → Run workflow** (manual dispatch).
Download the **cluster-proof** artifact for the session screenshot and the
per-worker daemon logs.

## Run it locally

On an Apple-Silicon Mac with Xcode simulators + Bun installed:

```bash
bun cluster.ts
```

Defaults target a machine with iOS 26 installed. Override the simulator with
`SIMD_DEVICE_TYPE` / `SIMD_RUNTIME` (see `xcrun simctl list runtimes`), or point
at a different app with `SIMD_APP` (a `.app` path or an `http(s)://` archive URL).
