.PHONY: test wasm web all

test:
	cargo test -p engine

wasm:
	./scripts/build-wasm.sh

web: wasm
	cd web && npm install && npm run build

all: test web
