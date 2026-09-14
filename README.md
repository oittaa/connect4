# Connect 4

A browser game with a Rust/WebAssembly engine. Play against another person or the computer.

## Build

Requires Rust, Node.js, and `wasm-bindgen-cli` matching the `wasm-bindgen` version in `Cargo.lock`.

```sh
rustup target add wasm32-unknown-unknown
./scripts/build-wasm.sh
cd web
npm ci
npm run build
```

Copy `web/dist/` to your web server. It also works under a subdirectory such as `/connect4/`.

For local development, run `npm run dev` from `web/` after building the WASM engine.

## Tests

Run `cargo test -p engine` from the repository root.

## License

MIT. The engine uses techniques described by John Tromp and Pascal Pons.
