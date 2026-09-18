#!/usr/bin/env python3
"""Tests for scripts/bench_difficult.py --save host merging."""

from __future__ import annotations

import importlib.util
import json
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = Path(__file__).resolve().parent / "bench_difficult.py"
DEFAULT_BASELINE = Path(__file__).resolve().parent / "testdata" / "baseline.json"


def load_bench():
    spec = importlib.util.spec_from_file_location("bench_difficult", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


bench = load_bench()

WINDOWS_HOST = {
    "cpu": "AMD Ryzen 9 7950X",
    "os": "Windows 11 AMD64",
    "binary": "target/release/c4solver",
    "engine": "rust",
    "no_book": True,
    "taskset": "0",
    "rustc": "rustc 1.98.1 (48a229cea 2026-09-01)",
    "target_cpu": "native (znver4)",
}

ROW_4444 = {
    "moves": "4444",
    "best_move": 4,
    "score": 1,
    "nodes": 105725361,
    "time_sec": 5.0,
    "knps": 21145.1,
}
ROW_44 = {
    "moves": "44",
    "best_move": 4,
    "score": 1,
    "nodes": 179171950,
    "time_sec": 10.0,
    "knps": 17917.2,
}


def write_mock_solver(directory: Path, nodes_by_moves: dict[str, int] | None = None) -> Path:
    mapping = nodes_by_moves or {"4444": 999, "44": 888}
    payload = json.dumps(mapping)
    path = directory / "mock-c4solver"
    path.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys\n"
        f"NODES = json.loads({payload!r})\n"
        "args = [a for a in sys.argv[1:] if a not in ('best-move', '--no-book')]\n"
        "moves = args[0] if args else ''\n"
        "print('best_move: 4')\n"
        "print('score: 1')\n"
        "print(f\"nodes: {NODES.get(moves, 100)}\")\n"
        "print('time: 0.001s')\n",
        encoding="utf-8",
    )
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


def run_bench(args: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=cwd or REPO_ROOT,
        capture_output=True,
        text=True,
    )


class MergeSaveTests(unittest.TestCase):
    def test_partial_save_refuses_when_host_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "baseline.json"
            previous = {"host": WINDOWS_HOST, "results": [ROW_4444, ROW_44]}
            path.write_text(json.dumps(previous, indent=2) + "\n", encoding="utf-8")
            linux_host = {**WINDOWS_HOST, "os": "Linux 6.12.94+ x86_64", "cpu": "Intel(R) Xeon(R) Processor"}
            measured = [{**ROW_4444, "nodes": 999, "time_sec": 0.001, "knps": 999000.0}]
            with self.assertRaises(ValueError) as caught:
                bench.merge_save(path, measured, linux_host)
            self.assertIn("refusing partial --save", str(caught.exception))
            self.assertIn("44", str(caught.exception))
            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(saved["host"]["os"], "Windows 11 AMD64")
            self.assertEqual(saved["results"][0]["nodes"], 105725361)
            self.assertEqual(saved["results"][1]["nodes"], 179171950)

    def test_complete_save_overwrites_host(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "baseline.json"
            path.write_text(
                json.dumps({"host": WINDOWS_HOST, "results": [ROW_4444, ROW_44]}, indent=2) + "\n",
                encoding="utf-8",
            )
            linux_host = {**WINDOWS_HOST, "os": "Linux 6.12.94+ x86_64"}
            measured = [
                {**ROW_4444, "nodes": 999},
                {**ROW_44, "nodes": 888},
            ]
            doc, kept = bench.merge_save(path, measured, linux_host)
            self.assertEqual(kept, 0)
            self.assertEqual(doc["host"]["os"], "Linux 6.12.94+ x86_64")
            self.assertEqual(doc["results"][0]["nodes"], 999)
            self.assertEqual(doc["results"][1]["nodes"], 888)

    def test_partial_save_merges_when_host_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "baseline.json"
            path.write_text(
                json.dumps({"host": WINDOWS_HOST, "results": [ROW_4444, ROW_44]}, indent=2) + "\n",
                encoding="utf-8",
            )
            measured = [{**ROW_4444, "nodes": 999}]
            doc, kept = bench.merge_save(path, measured, dict(WINDOWS_HOST))
            self.assertEqual(kept, 1)
            by_moves = {row["moves"]: row for row in doc["results"]}
            self.assertEqual(by_moves["4444"]["nodes"], 999)
            self.assertEqual(by_moves["44"]["nodes"], 179171950)
            self.assertEqual(doc["host"], WINDOWS_HOST)


class SaveCliTests(unittest.TestCase):
    def test_partial_save_cli_does_not_relabel_windows_rows(self):
        """Astra P3: a Linux partial --save must not stamp Linux host onto kept Windows timings."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            baseline = tmp_path / "baseline.json"
            baseline.write_text(
                json.dumps({"host": WINDOWS_HOST, "results": [ROW_4444, ROW_44]}, indent=2) + "\n",
                encoding="utf-8",
            )
            mock = write_mock_solver(tmp_path)
            proc = run_bench(["--bin", str(mock), "--save", str(baseline), "4444"])
            self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            self.assertIn("refusing partial --save", proc.stderr)
            saved = json.loads(baseline.read_text(encoding="utf-8"))
            self.assertEqual(saved["host"]["os"], "Windows 11 AMD64")
            self.assertEqual(saved["host"]["cpu"], "AMD Ryzen 9 7950X")
            by_moves = {row["moves"]: row for row in saved["results"]}
            self.assertEqual(by_moves["4444"]["nodes"], 105725361)
            self.assertEqual(by_moves["44"]["nodes"], 179171950)

    def test_complete_save_cli_rewrites_host(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            baseline = tmp_path / "baseline.json"
            baseline.write_text(
                json.dumps({"host": WINDOWS_HOST, "results": [ROW_4444, ROW_44]}, indent=2) + "\n",
                encoding="utf-8",
            )
            mock = write_mock_solver(tmp_path)
            proc = run_bench(["--bin", str(mock), "--save", str(baseline), "4444", "44"])
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            saved = json.loads(baseline.read_text(encoding="utf-8"))
            self.assertNotEqual(saved["host"]["os"], "Windows 11 AMD64")
            by_moves = {row["moves"]: row for row in saved["results"]}
            self.assertEqual(by_moves["4444"]["nodes"], 999)
            self.assertEqual(by_moves["44"]["nodes"], 888)

    def test_same_host_partial_save_keeps_unmeasured_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            baseline = tmp_path / "baseline.json"
            mock = write_mock_solver(tmp_path)
            first = run_bench(["--bin", str(mock), "--save", str(baseline), "4444"])
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            second = run_bench(["--bin", str(mock), "--save", str(baseline), "44"])
            self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
            self.assertIn("kept 1 positions not in this run", second.stdout)
            saved = json.loads(baseline.read_text(encoding="utf-8"))
            by_moves = {row["moves"]: row for row in saved["results"]}
            self.assertEqual(by_moves["4444"]["nodes"], 999)
            self.assertEqual(by_moves["44"]["nodes"], 888)

    def test_default_save_refuses_go_binary(self):
        with tempfile.TemporaryDirectory() as tmp:
            go_bin = Path(tmp) / "c4solver-go"
            go_bin.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
            go_bin.chmod(go_bin.stat().st_mode | stat.S_IXUSR)
            before = DEFAULT_BASELINE.read_bytes()
            try:
                proc = run_bench(["--bin", str(go_bin), "--save"])
                self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
                self.assertIn("refusing to write the Rust baseline", proc.stderr)
            finally:
                self.assertEqual(DEFAULT_BASELINE.read_bytes(), before)

    def test_post_book_sequences_are_in_the_default_set(self):
        self.assertEqual(
            bench.POST_BOOK_POSITIONS,
            ["444442222453", "763163667377", "433214444433"],
        )
        self.assertTrue(set(bench.POST_BOOK_POSITIONS).issubset(set(bench.STANDARD_ORDER)))


if __name__ == "__main__":
    unittest.main()
