.PHONY: test wasm web all empty-book

test:
	cargo test -p engine

wasm:
	./scripts/build-wasm.sh

web: wasm
	cd web && npm install && npm run build

all: test web

empty-book:
	cargo run --release -p engine -- empty --write-book web/public/books/opening.c4book
	cp -f web/public/books/opening.c4book books/opening.c4book
