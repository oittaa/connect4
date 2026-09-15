FROM node:26-slim AS node

FROM rust:1.98.1-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends make \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

WORKDIR /tmp/pins
COPY rust-toolchain.toml Cargo.lock ./
RUN rustup show \
    && version=$(awk '/^name = "wasm-bindgen"$/ { getline; if ($1 == "version") { gsub(/"/, "", $3); print $3; exit } }' Cargo.lock) \
    && test -n "$version" \
    && cargo install wasm-bindgen-cli --version "$version" --locked

ENV RUSTUP_AUTO_INSTALL=0
WORKDIR /repo
