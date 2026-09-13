import { parseMoveString, toMoveString } from "./game";

export function isDebugMode(): boolean {
  return new URLSearchParams(location.hash.slice(1)).has("DEBUG");
}

export function readMovesFromLocation(): number[] | null {
  const hash = location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const fromHash = params.get("moves") ?? (/^[1-7]+$/.test(hash) ? hash : null);
  const fromQuery = new URLSearchParams(location.search).get("moves");
  const raw = fromHash || fromQuery;
  if (raw === null || raw === "") return null;
  return parseMoveString(raw);
}

export function writeMovesToLocation(moves: number[]): void {
  const seq = toMoveString(moves);
  const url = new URL(location.href);
  url.searchParams.delete("moves");
  url.hash = [seq ? `moves=${seq}` : "", isDebugMode() ? "DEBUG" : ""]
    .filter(Boolean)
    .join("&");
  history.replaceState(null, "", url);
}
