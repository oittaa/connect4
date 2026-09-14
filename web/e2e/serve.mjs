import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const prefix = "/connect4";
const port = Number(process.env.E2E_PORT || 4173);
const host = "127.0.0.1";

const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".map", "application/json"],
  [".json", "application/json"],
  [".svg", "image/svg+xml"],
  [".c4book", "application/octet-stream"],
  [".c4move", "application/octet-stream"],
]);

if (!fs.existsSync(path.join(root, "index.html"))) {
  console.error("web/dist/index.html missing; run npm run build first");
  process.exit(1);
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === prefix) {
    res.writeHead(302, { Location: `${prefix}/` });
    res.end();
    return;
  }
  if (pathname === `${prefix}/`) pathname = `${prefix}/index.html`;
  if (!pathname.startsWith(`${prefix}/`)) {
    send(res, 404, "not found");
    return;
  }
  const rel = pathname.slice(`${prefix}/`.length);
  const file = path.resolve(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) {
    send(res, 403, "forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      send(res, 404, "not found");
      return;
    }
    send(res, 200, data, types.get(path.extname(file)) ?? "application/octet-stream");
  });
});

server.listen(port, host, () => {
  console.log(`e2e server http://${host}:${port}${prefix}/`);
});
