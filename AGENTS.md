# Agent notes

Connect 4 strong solver (Rust) plus a WASM web app. There is no Prettier/ESLint. CI is three jobs: **test**, **lint**, **web**. Match those commands before committing.

Toolchain is pinned:

- Rust **1.98.1** with `rustfmt`, `clippy`, and `wasm32-unknown-unknown` (`rust-toolchain.toml`)
- Node **26** in CI; web lockfile is `web/package-lock.json`
- `wasm-bindgen-cli` **0.2.128** (same version as `wasm-bindgen` in `Cargo.lock`)

Run commands from the repository root unless noted.

## Before every commit

If you edited **Rust** (`*.rs`, `Cargo.toml`, `Cargo.lock`, engine tests/examples):

```sh
cargo fmt --all
cargo test --locked -p engine
cargo clippy --locked -p engine --all-targets --all-features -- -D warnings
```

If the Rust change can affect WASM (`engine/src/wasm.rs`, solver/TT API the web crate uses, `wasm` feature):

```sh
cargo clippy --locked -p engine --target wasm32-unknown-unknown --features wasm --lib -- -D warnings
./scripts/build-wasm.sh
```

CI format is `cargo fmt --all -- --check`. Do not commit unformatted Rust.

If you edited **TypeScript/JS** (`web/**/*.ts`, `web/**/*.mjs`, `web/package.json`, Playwright):

```sh
cd web
npx tsc --noEmit
npm test
```

There is no TS formatter in the repo. Match the surrounding file: 2-space indent, double quotes, existing semicolon style. `tsc --noEmit` is the type gate (`noUnusedLocals` / `noUnusedParameters` are on).

If the TS change is user-visible UI, worker protocol, WASM ABI, books, or TT persist, also run browser e2e (rebuild WASM first when the engine changed):

```sh
./scripts/build-wasm.sh
cd web
npx playwright install --with-deps chromium   # once per machine
npm run test:browser
```

If you edited **both** sides, run both checklists. A green `cargo test` does not cover the web client.

If you made **algorithmic or solver changes**:

After every algorithmic change the build needs to be tested against the baseline, and before pushing to git the baseline needs to be updated:

```sh
# 1. Test against baseline (must verify correctness and check node count delta)
python scripts/bench_difficult.py --compare --heavy

# 2. Update baseline before pushing to git
python scripts/bench_difficult.py --save --heavy
```

## Layout

| Path | What |
|---|---|
| `engine/` | Solver, TT, books, `c4solver` CLI |
| `web/` | Vite UI, worker, unit tests (`src/*-test.ts`), e2e (`e2e/*.spec.ts`) |
| `gosolver/` | Standalone Go port of the Connect 4 solver |
| `books/` | Score/move books |
| `testdata/` | Pons `sequence score` files |
| `scripts/bench_difficult.py` | Benchmark runner and baseline comparison |
| `scripts/testdata/` | Benchmark baselines (`baseline.json`) |
| `scripts/build-wasm.sh` | `wasm32` release build + `wasm-bindgen` → `web/src/pkg` |

`web/src/pkg/` is generated and gitignored. Never commit it, `web/dist/`, `web/node_modules/`, `target/`, or `books/*.checkpoint`.

## Invariants

- `NO_COLUMN = 255` in `engine/src/wasm.rs` and `web/src/engineProtocol.ts` must stay identical.
- Packed WASM `previewScores` is 9×`i16` (7 column scores + `bookCol` + `provenCol`). Change both Rust and TS.
- Native TT is the 24-bit prime `16_777_259`; WASM is the 22-bit prime `4_194_319` (`TT_SIZE` in `engine/src/tt.rs`). Size is a compile-time constant on purpose (const reciprocal, not `divq` / dynamic `i64.rem_u`).
- Solver scores are exact game-theoretic values. Tests pin them. Faster search is fine; different scores are a bug.

## Local run

```sh
./scripts/build-wasm.sh
cd web && npm ci && npm run dev
```

CLI (after `cargo build --release -p engine`):

```sh
./target/release/c4solver solve 4444
```

`--no-book` disables the embedded 4-ply score book.

### Go solver (`gosolver/`)

For optimal speed, compile with Profile-Guided Optimization (`-pgo`) and stripped symbols (`-ldflags="-s -w"`). PGO raises the compiler's inlining budget and inlines hot functions like `computeWinningPosition`:

```sh
# 1. Sample CPU profile (run once or after changing solver logic)
go run ./gosolver/main.go -cpuprofile cpu.pprof 4444

# 2. Build with PGO
go build -pgo cpu.pprof -ldflags="-s -w" -o gosolver ./gosolver/main.go
```

## Cursor Cloud

- Repo root is `/workspace`. Rust 1.98.1 comes from `rust-toolchain.toml`.
- Web tests: `npm ci` then `npm test` in `web/`. Playwright needs Chromium installed once as above.
- Solver timings: pin with `taskset -c 0`. Each `c4solver` process is a cold TT (~80 MiB native).
- Do not kill long `c4solver` or `perf` jobs by name; use the PID.
