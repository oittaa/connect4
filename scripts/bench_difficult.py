#!/usr/bin/env python3
"""
Benchmark Connect 4 solvers (Rust c4solver and Go gosolver) on difficult positions.

Usage:
    python scripts/bench_difficult.py [POSITIONS...] [OPTIONS]

Options:
    --bin PATH          Path to solver binary (default: target/release/c4solver)
    --heavy             Include very heavy positions (empty board, '4')
    --save [FILE]       Save results to JSON (default: scripts/testdata/baseline.json)
    --compare [FILE]    Compare results against JSON baseline (default: scripts/testdata/baseline.json)
    --with-book         Enable opening book for Rust solver (default: pure search)
"""

import argparse
import json
import os
import re
import subprocess
import time
from typing import Dict, List, Optional, Any

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BASELINE_PATH = os.path.join(SCRIPT_DIR, "testdata", "baseline.json")

DEFAULT_POSITIONS = [
    ("44444666", "Ply 8 (User case: Col 6 win vs center)"),
    ("54431",    "Ply 5 (Complex draw defense)"),
    ("43321",    "Ply 5 (Sharp tactical loss position)"),
    ("4444",     "Ply 4 (Center column battle)"),
    ("44",       "Ply 2 (Center response)"),
    ("45",       "Ply 2 (Off-center response)"),
]

HEAVY_POSITIONS = [
    ("4",        "Ply 1 (Single center disc)"),
    ("",         "Ply 0 (Empty board)"),
]

def find_solver_bin(override_path: Optional[str] = None) -> str:
    if override_path:
        if os.path.exists(override_path):
            return override_path
        raise FileNotFoundError(f"Solver binary not found at: {override_path}")

    candidates = [
        os.path.join("target", "release", "c4solver.exe"),
        os.path.join("target", "release", "c4solver"),
        os.path.join("..", "target", "release", "c4solver.exe"),
        os.path.join("..", "target", "release", "c4solver"),
        os.path.join("c4solver-go.exe"),
        os.path.join("c4solver-go"),
        os.path.join("gosolver", "c4solver-go.exe"),
        os.path.join("gosolver", "c4solver-go"),
        os.path.join("gosolver", "main.go"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    raise FileNotFoundError(
        "Could not find solver executable in target/release. "
        "Please build it with: cargo build --release -p engine"
    )

def is_go_solver(bin_path: str) -> bool:
    base = os.path.basename(bin_path).lower()
    return "c4solver-go" in base or "gosolver" in base or base.endswith(".go")

def run_solver(bin_path: str, moves: str, no_book: bool = True) -> Dict[str, Any]:
    if is_go_solver(bin_path):
        if bin_path.endswith(".go"):
            cmd = ["go", "run", bin_path, moves]
        else:
            cmd = [bin_path, moves]
    else:
        cmd = [bin_path, "best-move", moves]
        if no_book:
            cmd.append("--no-book")

    t0 = time.perf_counter()
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    wall_time = time.perf_counter() - t0

    if proc.returncode != 0:
        raise RuntimeError(
            f"Solver failed (exit {proc.returncode}) for moves '{moves}':\n"
            f"cmd: {' '.join(cmd)}\n"
            f"stdout: {proc.stdout}\nstderr: {proc.stderr}"
        )

    stdout = proc.stdout

    # Parse best move: supports both "best_move: 4" and "best_column 3 (1-based 4)"
    best_col_m = (
        re.search(r"best_move:\s*(\d+)", stdout)
        or re.search(r"best_column\s+\d+\s+\(1-based\s+(\d+)\)", stdout)
    )

    # Parse score: supports both "score: 1" and "score 1"
    score_m = (
        re.search(r"score:\s*(-?\d+)", stdout)
        or re.search(r"score\s+(-?\d+)", stdout)
    )

    # Parse nodes: supports both "nodes: 871198207" and "nodes 871198207"
    nodes_m = (
        re.search(r"nodes:\s*(\d+)", stdout)
        or re.search(r"nodes\s+(\d+)", stdout)
    )

    # Parse time: supports "time: 41.354s" or "nodes 123 35.578s"
    time_m = (
        re.search(r"time:\s*([0-9.]+)s", stdout)
        or re.search(r"nodes\s+\d+\s+([0-9.]+)s", stdout)
    )

    if not best_col_m or not score_m or not nodes_m:
        raise ValueError(f"Could not parse solver output for '{moves}':\n{stdout}")

    best_move_1based = int(best_col_m.group(1))
    score = int(score_m.group(1))
    nodes = int(nodes_m.group(1))
    reported_time = float(time_m.group(1)) if time_m else round(wall_time, 3)

    knps = (nodes / reported_time / 1000.0) if reported_time > 0 else 0.0

    return {
        "moves": moves,
        "best_move": best_move_1based,
        "score": score,
        "nodes": nodes,
        "time_sec": reported_time,
        "wall_sec": round(wall_time, 3),
        "knps": round(knps, 1),
    }

def print_table(results: List[Dict[str, Any]], baseline: Optional[Dict[str, Dict[str, Any]]] = None):
    print("\n" + "=" * 92)
    if baseline:
        print(f"{'Position':<12} | {'Move':<6} | {'Score':<5} | {'Nodes':<12} | {'Base Nodes':<12} | {'Diff %':<8} | {'Time (s)':<8} | {'Base (s)':<8}")
        print("-" * 92)
        for r in results:
            pos = r["moves"] or '""'
            bm = f"Col {r['best_move']}"
            sc = f"{r['score']:+d}"
            nd = f"{r['nodes']:,}"
            tm = f"{r['time_sec']:.3f}"

            base = baseline.get(r["moves"])
            if base:
                b_nd = f"{base['nodes']:,}"
                b_tm = f"{base['time_sec']:.3f}"
                pct = ((r["nodes"] - base["nodes"]) / base["nodes"]) * 100.0
                pct_str = f"{pct:+.1f}%"
            else:
                b_nd = "N/A"
                b_tm = "N/A"
                pct_str = "N/A"

            print(f"{pos:<12} | {bm:<6} | {sc:<5} | {nd:<12} | {b_nd:<12} | {pct_str:<8} | {tm:<8} | {b_tm:<8}")
    else:
        print(f"{'Position':<12} | {'Move':<7} | {'Score':<5} | {'Nodes':<14} | {'Time (s)':<10} | {'Speed (kN/s)':<12}")
        print("-" * 92)
        for r in results:
            pos = r["moves"] or '""'
            bm = f"Col {r['best_move']}"
            sc = f"{r['score']:+d}"
            nd = f"{r['nodes']:,}"
            tm = f"{r['time_sec']:.3f}"
            knps = f"{r['knps']:,.1f}"
            print(f"{pos:<12} | {bm:<7} | {sc:<5} | {nd:<14} | {tm:<10} | {knps:<12}")

    print("=" * 92)
    tot_nodes = sum(r["nodes"] for r in results)
    tot_time = sum(r["time_sec"] for r in results)
    avg_knps = (tot_nodes / tot_time / 1000.0) if tot_time > 0 else 0
    print(f"TOTAL: {tot_nodes:,} nodes in {tot_time:.3f}s ({avg_knps:,.1f} kN/s)")

    if baseline:
        b_tot_nodes = sum(baseline[r["moves"]]["nodes"] for r in results if r["moves"] in baseline)
        b_tot_time = sum(baseline[r["moves"]]["time_sec"] for r in results if r["moves"] in baseline)
        if b_tot_nodes > 0:
            node_diff_pct = ((tot_nodes - b_tot_nodes) / b_tot_nodes) * 100.0
            time_diff_pct = ((tot_time - b_tot_time) / b_tot_time) * 100.0
            print(f"NODE DELTA: {node_diff_pct:+.2f}%  |  TIME DELTA: {time_diff_pct:+.2f}%")
    print("=" * 92 + "\n")

def main():
    parser = argparse.ArgumentParser(description="Benchmark Connect 4 solvers on difficult positions.")
    parser.add_argument("positions", nargs="*", help="Specific positions to solve (e.g. 44444666 54431)")
    parser.add_argument("--bin", default=None, help="Path to solver binary (c4solver or gosolver)")
    parser.add_argument("--heavy", action="store_true", help="Include heavy positions ('4', empty board)")
    parser.add_argument(
        "--save",
        action="store_true",
        help=f"Save results to default JSON file ({DEFAULT_BASELINE_PATH})",
    )
    parser.add_argument(
        "--save-path",
        default=None,
        help=f"Custom file path to save results (overrides default)",
    )
    parser.add_argument(
        "--compare",
        action="store_true",
        help=f"Compare results with baseline JSON (default: {DEFAULT_BASELINE_PATH})",
    )
    parser.add_argument(
        "--baseline-path",
        default=None,
        help="Custom baseline JSON file to compare against",
    )
    parser.add_argument("--with-book", action="store_true", help="Enable opening book (default: pure search)")

    args = parser.parse_args()
    solver_bin = find_solver_bin(args.bin)
    no_book = not args.with_book
    is_go = is_go_solver(solver_bin)

    pos_list = []
    if args.positions:
        pos_list = [(p, "") for p in args.positions]
    else:
        pos_list.extend(DEFAULT_POSITIONS)
        if args.heavy:
            pos_list.extend(HEAVY_POSITIONS)

    print(f"Solver binary: {solver_bin} ({'Go' if is_go else 'Rust'})")
    if not is_go:
        print(f"Mode: {'Pure search (--no-book)' if no_book else 'With opening book'}")
    print(f"Running {len(pos_list)} positions...\n")

    results = []
    for moves, desc in pos_list:
        desc_str = f" ({desc})" if desc else ""
        disp_name = moves if moves else '""'
        print(f"Solving {disp_name}{desc_str}...", end="", flush=True)
        r = run_solver(solver_bin, moves, no_book=no_book)
        results.append(r)
        print(f" Best: Col {r['best_move']}, Score {r['score']:+d}, Nodes: {r['nodes']:,}, Time: {r['time_sec']:.3f}s")

    baseline = None
    baseline_file = args.baseline_path or (DEFAULT_BASELINE_PATH if args.compare else None)
    if baseline_file:
        if not os.path.exists(baseline_file):
            print(f"Warning: baseline file not found: {baseline_file}")
        else:
            with open(baseline_file, "r", encoding="utf-8") as f:
                base_data = json.load(f)
                baseline = {item["moves"]: item for item in base_data}

    print_table(results, baseline)

    save_target = args.save_path or (DEFAULT_BASELINE_PATH if args.save else None)
    if save_target:
        os.makedirs(os.path.dirname(os.path.abspath(save_target)), exist_ok=True)
        with open(save_target, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2)
        print(f"Results saved to {save_target}")

if __name__ == "__main__":
    main()
