import { parseMoveString, toMoveString } from "./game";

export function readMovesFromLocation(): number[] | null {
  const hash = location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash.includes("=") ? hash : `moves=${hash}`);
  const fromHash = params.get("moves");
  const fromQuery = new URLSearchParams(location.search).get("moves");
  const raw = fromHash || fromQuery;
  if (raw === null || raw === "") return null;
  return parseMoveString(raw);
}

export function writeMovesToLocation(moves: number[]): void {
  const seq = toMoveString(moves);
  const url = new URL(location.href);
  url.searchParams.delete("moves");
  url.hash = seq ? `moves=${seq}` : "";
  history.replaceState(null, "", url);
}
