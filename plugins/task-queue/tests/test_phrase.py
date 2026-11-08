"""bin/phrase: one short line a session's character says, from the local fm model.

Run: python3 -I plugins/task-queue/tests/test_phrase.py
A fake fm on FM_BIN stands in for the model; nothing here calls the real one.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

CLI = Path(__file__).resolve().parent.parent / "bin" / "phrase"


def run(name, fm_output, fm_exit=0, races=None, seen=None):
    with tempfile.TemporaryDirectory() as d:
        fake = Path(d) / "fm"
        out = Path(d) / "out.txt"
        args = Path(d) / "args.txt"
        out.write_text(fm_output)
        fake.write_text(f"#!/bin/sh\nfor a in \"$@\"; do echo \"$a\"; done > '{args}'\ncat '{out}'\nexit {fm_exit}\n")
        fake.chmod(0o755)
        env = {**os.environ, "FM_BIN": str(fake), "PHRASE_RACES": str(Path(d) / "races.json")}
        if races is not None:
            (Path(d) / "races.json").write_text(json.dumps(races))
        r = subprocess.run([sys.executable, "-I", str(CLI), name], capture_output=True, text=True, env=env)
        if seen is not None and args.exists():
            seen.extend(args.read_text().splitlines())
        return r.returncode, r.stdout


class Phrase(unittest.TestCase):
    def test_a_plain_line_is_printed(self):
        self.assertEqual(run("Lin-Yao", "Ветер над болотом\n"), (0, "Ветер над болотом\n"))

    def test_markdown_quotes_and_a_final_period_are_stripped(self):
        self.assertEqual(run("X", '- **«Пусть будет война.»**\n')[1], "Пусть будет война\n")

    def test_only_the_first_nonempty_line_counts(self):
        self.assertEqual(run("X", "\nФраза для X\n- другое\n")[1], "Фраза для X\n")

    def test_a_refusal_or_error_prints_nothing(self):
        self.assertEqual(run("X", "Error: The model's safety guardrails were triggered.\n", 1), (0, ""))

    def test_a_line_too_long_for_the_pane_prints_nothing(self):
        self.assertEqual(run("X", "раз два три четыре пять шесть семь восемь\n"), (0, ""))

    def test_the_prompt_names_the_characters_race_from_the_roster(self):
        seen = []
        races = {"argonian": {"first": {"m": ["Derkeethus"]}}, "khajiit": {"first": {"f": ["S'Krivva"]}}}
        run("Derkeethus", "Life flows through roots\n", races=races, seen=seen)
        prompt = seen[-1]
        self.assertIn("Derkeethus, an Argonian", prompt)

    def test_a_name_with_a_surname_is_found_by_its_first_name(self):
        seen = []
        run("Marcus Varro", "Roads lead home\n", races={"imperial": {"first": {"m": ["Marcus"]}}}, seen=seen)
        self.assertIn("Marcus Varro, an Imperial", seen[-1])

    def test_without_a_roster_entry_the_prompt_has_no_race(self):
        seen = []
        run("Nobody", "Safe journey\n", races={"nord": {"first": {"m": ["Ulf"]}}}, seen=seen)
        self.assertRegex(seen[-1], r"^Character name: Nobody\. Theme: ")

    def test_no_fm_prints_nothing(self):
        env = {**os.environ, "FM_BIN": "/nonexistent/fm"}
        r = subprocess.run([sys.executable, "-I", str(CLI), "X"], capture_output=True, text=True, env=env)
        self.assertEqual((r.returncode, r.stdout), (0, ""))


if __name__ == "__main__":
    unittest.main()
