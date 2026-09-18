#!/usr/bin/env python3
"""Benchmark c4solver on hard positions. Run from the repo root.

  python scripts/bench_difficult.py [--bin PATH] [--heavy] [--compare [FILE]] [--save [FILE]] [POSITIONS...]

Default binary: target/release/c4solver (never gosolver/main.go).
Default --compare/--save file: scripts/testdata/baseline.json (Rust, --no-book).
A 1-7 move string after --compare/--save is a position, not a file.
--save to that path requires the Rust binary and refuses --with-book.
--save merges by position, so a non-heavy run does not drop empty/"4".
--compare exits 1 if score, best-move, or node count differs. Times are printed only.
"""

from __future__ import annotations

import argparse
import json
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASELINE = Path(__file__).resolve().parent / "testdata" / "baseline.json"
DEFAULT_BIN = REPO_ROOT / "target" / "release" / "c4solver"

DEFAULT_POSITIONS = ["44444666", "54431", "43321", "4444", "44", "45"]
HEAVY_POSITIONS = ["4", ""]

BEST_MOVE_RE = re.compile(r"^best_move:\s*(\d+)\s*$", re.M)
SCORE_RE = re.compile(r"^score:\s*(-?\d+)\s*$", re.M)
NODES_RE = re.compile(r"^nodes:\s*(\d+)\s*$", re.M)
TIME_RE = re.compile(r"^time:\s*([0-9.]+)s", re.M)
MOVES_RE = re.compile(r"[1-7]+")


class OptionalBaselinePath(argparse.Action):
    def __call__(self, parser, namespace, values, option_string=None):
        extras = getattr(namespace, "_extra_positions", None)
        if extras is None:
            extras = []
            setattr(namespace, "_extra_positions", extras)
        if values is None:
            setattr(namespace, self.dest, str(DEFAULT_BASELINE))
            return
        if MOVES_RE.fullmatch(values) and not Path(values).is_file():
            setattr(namespace, self.dest, str(DEFAULT_BASELINE))
            extras.append(values)
            return
        setattr(namespace, self.dest, values)


def is_go_solver(bin_path: Path) -> bool:
    name = bin_path.name.lower()
    return "c4solver-go" in name or "gosolver" in name or name.endswith(".go")


def resolve_bin(override: str | None) -> Path:
    if override:
        path = Path(override).expanduser()
        if not path.is_absolute():
            path = (Path.cwd() / path).resolve()
        if not path.exists():
            raise FileNotFoundError(f"solver binary not found: {path}")
        return path
    for candidate in (DEFAULT_BIN, DEFAULT_BIN.with_suffix(".exe")):
        if candidate.exists():
            return candidate
    raise FileNotFoundError(
        f"Rust solver not found at {DEFAULT_BIN}. "
        "Build it with: cargo build --release -p engine"
    )


def cpu_model() -> str:
    cpuinfo = Path("/proc/cpuinfo")
    if cpuinfo.is_file():
        for line in cpuinfo.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.lower().startswith("model name"):
                return line.split(":", 1)[1].strip()
    return platform.processor() or "unknown"


def rustc_version() -> str | None:
    try:
        out = subprocess.run(
            ["rustc", "--version"],
            check=True,
            capture_output=True,
            text=True,
        )
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def target_cpu_label() -> str | None:
    cfg = REPO_ROOT / ".cargo" / "config.toml"
    configured = None
    if cfg.is_file():
        match = re.search(
            r"target-cpu=([A-Za-z0-9_-]+)",
            cfg.read_text(encoding="utf-8"),
        )
        if match:
            configured = match.group(1)
    resolved = None
    try:
        out = subprocess.run(
            ["rustc", "--print", "target-cpus"],
            check=True,
            capture_output=True,
            text=True,
        )
        native = re.search(r"native\s+-.*\(currently\s+([^)]+)\)", out.stdout)
        if native:
            resolved = native.group(1).strip()
    except (OSError, subprocess.CalledProcessError):
        pass
    if configured and resolved:
        return f"{configured} ({resolved})"
    return configured or resolved


def rel_bin(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def host_info(bin_path: Path, engine: str, no_book: bool, pinned_cpu: str | None) -> dict:
    info = {
        "cpu": cpu_model(),
        "os": f"{platform.system()} {platform.release()} {platform.machine()}",
        "binary": rel_bin(bin_path),
        "engine": engine,
        "no_book": no_book,
        "taskset": pinned_cpu,
    }
    if engine == "rust":
        info["rustc"] = rustc_version()
        info["target_cpu"] = target_cpu_label()
    else:
        info["rustc"] = None
        info["target_cpu"] = None
    return info


def solver_cmd(bin_path: Path, moves: str, no_book: bool, go: bool) -> list[str]:
    if go:
        if bin_path.suffix == ".go":
            cmd = ["go", "run", str(bin_path), moves]
        else:
            cmd = [str(bin_path), moves]
    else:
        cmd = [str(bin_path), "best-move", moves]
        if no_book:
            cmd.append("--no-book")
    taskset = shutil.which("taskset")
    if taskset:
        cmd = [taskset, "-c", "0", *cmd]
    return cmd


def parse_output(stdout: str, moves: str) -> dict:
    best = BEST_MOVE_RE.search(stdout)
    score = SCORE_RE.search(stdout)
    nodes = NODES_RE.search(stdout)
    time_m = TIME_RE.search(stdout)
    if not best or not score or not nodes or not time_m:
        raise ValueError(f"could not parse solver output for {moves!r}:\n{stdout}")
    nodes_n = int(nodes.group(1))
    time_sec = float(time_m.group(1))
    knps = (nodes_n / time_sec / 1000.0) if time_sec > 0 else 0.0
    return {
        "moves": moves,
        "best_move": int(best.group(1)),
        "score": int(score.group(1)),
        "nodes": nodes_n,
        "time_sec": time_sec,
        "knps": round(knps, 1),
    }


def run_solver(bin_path: Path, moves: str, no_book: bool, go: bool) -> dict:
    cmd = solver_cmd(bin_path, moves, no_book, go)
    proc = subprocess.run(
        cmd,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=600,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"solver failed (exit {proc.returncode}) for {moves!r}:\n"
            f"cmd: {' '.join(cmd)}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
        )
    return parse_output(proc.stdout, moves)


def load_baseline(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        return {"host": {}, "results": data}
    if not isinstance(data, dict) or "results" not in data:
        raise ValueError(f"invalid baseline schema: {path}")
    return data


def ordered_results(updated: list[dict], previous: list[dict]) -> list[dict]:
    by_moves = {row["moves"]: row for row in previous}
    for row in updated:
        by_moves[row["moves"]] = row
    ordered = []
    seen: set[str] = set()
    for moves in DEFAULT_POSITIONS + HEAVY_POSITIONS:
        if moves in by_moves:
            ordered.append(by_moves[moves])
            seen.add(moves)
    for row in updated:
        if row["moves"] not in seen:
            ordered.append(row)
            seen.add(row["moves"])
    for moves, row in by_moves.items():
        if moves not in seen:
            ordered.append(row)
    return ordered


def print_table(results: list[dict], baseline: dict | None) -> None:
    base_rows = {row["moves"]: row for row in baseline["results"]} if baseline else {}
    headers = (
        f"{'pos':<10} {'move':<6} {'score':<6} {'nodes':<12} "
        f"{'base_mv':<7} {'base_sc':<7} {'base_nodes':<12} {'nodes%':<8} {'s':<8} {'base_s':<8}"
    )
    print(headers)
    print("-" * len(headers))
    for row in results:
        pos = row["moves"] or '""'
        base = base_rows.get(row["moves"])
        if base:
            node_pct = ((row["nodes"] - base["nodes"]) / base["nodes"]) * 100.0 if base["nodes"] else 0.0
            base_mv = str(base["best_move"])
            base_sc = f"{base['score']:+d}"
            base_nodes = f"{base['nodes']:,}"
            pct = f"{node_pct:+.1f}%"
            base_t = f"{base['time_sec']:.3f}"
        else:
            base_mv = base_sc = base_nodes = pct = base_t = "-"
        print(
            f"{pos:<10} {row['best_move']:<6} {row['score']:+d}    {row['nodes']:<12,} "
            f"{base_mv:<7} {base_sc:<7} {base_nodes:<12} {pct:<8} {row['time_sec']:<8.3f} {base_t:<8}"
        )


def compare(results: list[dict], baseline: dict, engine: str) -> list[str]:
    errors = []
    base_host = baseline.get("host") or {}
    base_engine = base_host.get("engine")
    if base_engine and base_engine != engine:
        errors.append(f"engine mismatch: baseline {base_engine!r} vs current {engine!r}")
    base_rows = {row["moves"]: row for row in baseline.get("results", [])}
    for row in results:
        label = row["moves"] or '""'
        base = base_rows.get(row["moves"])
        if base is None:
            errors.append(f"{label}: not in baseline")
            continue
        if row["score"] != base["score"]:
            errors.append(f"{label}: score {row['score']} != baseline {base['score']}")
        if row["best_move"] != base["best_move"]:
            errors.append(
                f"{label}: best_move {row['best_move']} != baseline {base['best_move']}"
            )
        if row["nodes"] != base["nodes"]:
            errors.append(f"{label}: nodes {row['nodes']} != baseline {base['nodes']}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Benchmark Connect 4 solvers on difficult positions."
    )
    parser.add_argument("positions", nargs="*", help="Move strings (1-based columns)")
    parser.add_argument("--bin", default=None, help="Solver binary (default: target/release/c4solver)")
    parser.add_argument("--heavy", action="store_true", help="Also run '4' and the empty board")
    parser.add_argument(
        "--save",
        nargs="?",
        const=str(DEFAULT_BASELINE),
        default=None,
        metavar="FILE",
        action=OptionalBaselinePath,
        help=f"Write results (default FILE: {DEFAULT_BASELINE})",
    )
    parser.add_argument(
        "--compare",
        nargs="?",
        const=str(DEFAULT_BASELINE),
        default=None,
        metavar="FILE",
        action=OptionalBaselinePath,
        help=f"Fail on score/best-move/node mismatch (default FILE: {DEFAULT_BASELINE})",
    )
    parser.add_argument("--with-book", action="store_true", help="Keep the Rust opening book")
    args = parser.parse_args()

    bin_path = resolve_bin(args.bin)
    go = is_go_solver(bin_path)
    engine = "go" if go else "rust"
    no_book = not args.with_book
    if go and args.with_book:
        print("Go solver has no book; ignoring --with-book", file=sys.stderr)

    save_path = Path(args.save).resolve() if args.save else None
    default_path = DEFAULT_BASELINE.resolve()
    if save_path == default_path and engine != "rust":
        print(
            f"refusing to write the Rust baseline ({default_path}) from a Go solver",
            file=sys.stderr,
        )
        return 1
    if save_path == default_path and not no_book:
        print(
            f"refusing to write the Rust baseline ({default_path}) with --with-book",
            file=sys.stderr,
        )
        return 1

    extras = list(getattr(args, "_extra_positions", []) or [])
    if extras or args.positions:
        positions = extras + list(args.positions)
    else:
        positions = list(DEFAULT_POSITIONS)
        if args.heavy:
            positions.extend(HEAVY_POSITIONS)

    pinned = "0" if shutil.which("taskset") else None
    print(f"binary: {bin_path} ({engine})")
    if not go:
        print(f"mode: {'pure search (--no-book)' if no_book else 'with opening book'}")
    if pinned:
        print("cpu: taskset -c 0")
    print(f"positions: {len(positions)}")

    results = []
    for moves in positions:
        label = moves or '""'
        print(f"solving {label}...", end="", flush=True)
        row = run_solver(bin_path, moves, no_book=no_book, go=go)
        results.append(row)
        print(
            f" move {row['best_move']} score {row['score']:+d} "
            f"nodes {row['nodes']:,} {row['time_sec']:.3f}s",
            flush=True,
        )

    baseline = None
    if args.compare:
        compare_path = Path(args.compare)
        if not compare_path.is_file():
            print(f"baseline not found: {compare_path}", file=sys.stderr)
            return 1
        baseline = load_baseline(compare_path)

    print()
    print_table(results, baseline)
    sys.stdout.flush()

    if save_path is not None:
        previous = load_baseline(save_path) if save_path.is_file() else {"host": {}, "results": []}
        kept = sum(
            1
            for row in previous.get("results", [])
            if row["moves"] not in {r["moves"] for r in results}
        )
        doc = {
            "host": host_info(bin_path, engine, no_book, pinned),
            "results": ordered_results(results, previous.get("results", [])),
        }
        save_path.parent.mkdir(parents=True, exist_ok=True)
        save_path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        extra = f" (kept {kept} positions not in this run)" if kept else ""
        print(f"saved {save_path}{extra}")

    if args.compare:
        errors = compare(results, baseline, engine)
        if errors:
            print("compare failed:", file=sys.stderr)
            for err in errors:
                print(f"  {err}", file=sys.stderr)
            return 1
        print("compare ok: score, best-move, and nodes match")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (FileNotFoundError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        print(exc, file=sys.stderr)
        sys.exit(1)
