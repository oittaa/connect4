# Connect 4

The solver is a WebAssembly engine (49-bit bitboard + negamax). Human vs human
works immediately; computer seats and analysis wait on the engine.

## Play

- Default: both seats **Human**. Switch either seat to Easy / Medium / Perfect at any time.
- **Back / Forward** (Z / Y, ← / →) rewind mistakes; a new drop from the middle of the line truncates the future.
- **Show best moves** scores every column (W/D/L).
- **Copy link** writes `#moves=44452…` (1-based columns) so a position is shareable.
- Computer vs computer is a show match; use the delay slider and Pause.

## Build

```bash
# solver tests + CLI
cargo test -p engine
cargo run --release -p engine -- bench testdata/end_easy
cargo run --release -p engine --example book_frontier -- 3
cargo run --release -p engine -- empty --book books/2ply.c4book

# resumable compact best-move book generation and validation
cargo run --release -p engine -- gen-move-book --depth 10 \
  --scores books/10ply.c4book --out books/10ply.c4move \
  --threads 4 --tt-bits 22
cargo run --release -p engine -- validate-move-book \
  --scores books/10ply.c4book --book books/10ply.c4move \
  --sample 100 --tt-bits 22

# web (needs rustup target wasm32-unknown-unknown and wasm-bindgen-cli)
./scripts/build-wasm.sh
cd web && npm install && npm run build
```

Static output is `web/dist/`, ready to copy to `/connect4/`.

The `book_frontier` example measures choosing moves just beyond the embedded
4-ply and downloaded 8-ply books, with a fresh search cache and the browser's
24 MiB table size. Its CSV output includes the move, node count, and search time.
Computer move selection uses the known parent score to test candidates with a
single null-window search. **Show best moves** still requests full column scores
before the computer moves; this optimization does not shorten that analysis wait.

## Engine

Independent implementation of published techniques (MIT):

- John Tromp’s 49-bit bitboard and 8-shift win test
- Pascal Pons’ negamax / alpha-beta / null-window score search / threat filtering

Pons’ and Steininger’s source is AGPL; this tree does not copy it.

Opening book: `C4BK` v2, sorted 4-byte `key3` + 1-byte score. Name files by
depth (`books/2ply.c4book`). The engine embeds `books/4ply.c4book` (3,607 bytes)
so early positions work as soon as WebAssembly is ready. The web app downloads
`books/opening.c4book` in the background and replaces the embedded book only
after a successful load. Failed downloads leave the smaller book available.
Valid empty, shallower, or sparse books retain the embedded 4-ply coverage:
missing entries are filled from the embedded book before it is replaced.
Copy the latest larger book to `web/public/books/opening.c4book` when deploying;
the current version is 8 ply. The web app intentionally keeps that score book
and independently downloads `web/public/books/10ply.c4move` for immediate
computer move selection through ply 10. A move-book hit bypasses parent and
child scoring; **Show best moves** still uses full scored analysis.

The compact move book is `C4MV` v1: dense height/combinadic indexing and packed
3-bit columns, with 7 reserved for an unknown slot. See
[`docs/c4mv.md`](docs/c4mv.md) for the byte-level format. Existing output is a
safe checkpoint: rerun the same `gen-move-book` command to solve only missing
entries. `--pilot N`, `--limit N`, and `--seconds N` bound representative or
partial generation runs. A partial file remains a valid fallback-enabled book,
but must not be published as the complete depth-10 asset.

The opening-book toggle and solver diagnostics are visible only with `#DEBUG`
(or `#moves=44452&DEBUG`). Turning the toggle off cancels any pending book
download and restores the embedded 4-ply book.

```bash
c4solver gen-book --depth 2 --out books/2ply.c4book
c4solver gen-book --depth 4 --out books/2ply.c4book   # continues in the same file
```

## License

MIT. See `LICENSE`.
