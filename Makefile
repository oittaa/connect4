.PHONY: test wasm web all gosolver

test:
	cargo test -p engine

wasm:
	./scripts/build-wasm.sh

web: wasm
	cd web && npm install && npm run build

all: test web

gosolver:
	go run ./gosolver/main.go -cpuprofile cpu.pprof 44444666
	go build -pgo cpu.pprof -ldflags="-s -w" -o c4solver-go ./gosolver/main.go
