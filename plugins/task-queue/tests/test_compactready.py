"""bin/compactready, run as the Stop hook runs it, over a synthetic transcript and session list.

Run: python3 -I plugins/task-queue/tests/test_compactready.py
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

CLI = Path(__file__).resolve().parent.parent / "bin" / "compactready"


def assistant(total):
    return {"type": "assistant", "message": {"role": "assistant", "content": [],
                                             "usage": {"input_tokens": 10, "cache_read_input_tokens": total - 10,
                                                       "cache_creation_input_tokens": 0}}}


class CompactReady(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        self.transcript = root / "t.jsonl"
        self.sessions = root / "sessions"
        self.ready = root / "ready"
        self.sessions.mkdir()
        (self.sessions / "1.json").write_text(json.dumps({"name": "Noor⚔️", "sessionId": "sid-1", "cwd": "/x"}))

    def tearDown(self):
        self.dir.cleanup()

    def run_cli(self, tokens, *extra, sid="sid-1"):
        self.transcript.write_text("\n".join(json.dumps(x) for x in [assistant(tokens)]) + "\n")
        r = subprocess.run([sys.executable, "-I", str(CLI), "--transcript", str(self.transcript), "--session-id", sid,
                            "--sessions-dir", str(self.sessions), "--ready-dir", str(self.ready), *extra],
                           capture_output=True, text=True, env={"QUEUE_CONTEXT_WINDOW": "1000000", "HOME": "/nonexistent"})
        return r.returncode, r.stdout.strip()

    def test_past_the_threshold_without_a_file_it_names_the_file(self):
        rc, out = self.run_cli(820_000)
        self.assertEqual(rc, 1, "a session at 82 % with no ready file is nudged")
        self.assertIn("82 %", out)
        self.assertIn(str(self.ready / "Noor.txt"), out, "the line names the file under the bare name")

    def test_under_en_the_line_is_english(self):
        rc, out = self.run_cli(820_000, "--lang", "en")
        self.assertEqual(rc, 1)
        self.assertTrue(out.startswith("context 82 %:"), out)
        self.assertNotRegex(out, "[\u0400-\u04ff]")
        self.assertIn(str(self.ready / "Noor.txt"), out)

    def test_below_the_threshold_it_is_silent(self):
        self.assertEqual(self.run_cli(790_000), (0, ""))

    def test_a_written_ready_file_silences_it(self):
        self.ready.mkdir()
        (self.ready / "Noor.txt").write_text("продолжаю по заметке")
        self.assertEqual(self.run_cli(900_000), (0, ""))

    def test_the_second_stop_of_a_turn_passes(self):
        self.assertEqual(self.run_cli(900_000, "--stop-hook-active"), (0, ""))

    def test_it_nudges_once_per_five_percent(self):
        self.assertEqual(self.run_cli(820_000)[0], 1)
        self.assertEqual(self.run_cli(840_000), (0, ""), "two points later it stays quiet")
        self.assertEqual(self.run_cli(870_000)[0], 1, "five points later it nudges again")

    def test_an_unknown_session_is_silent(self):
        self.assertEqual(self.run_cli(900_000, sid="sid-other"), (0, ""))

    def test_a_compacted_transcript_is_silent(self):
        self.transcript.write_text(json.dumps(assistant(900_000)) + "\n" +
                                   json.dumps({"type": "system", "subtype": "compact_boundary"}) + "\n")
        r = subprocess.run([sys.executable, "-I", str(CLI), "--transcript", str(self.transcript), "--session-id", "sid-1",
                            "--sessions-dir", str(self.sessions), "--ready-dir", str(self.ready)],
                           capture_output=True, text=True)
        self.assertEqual((r.returncode, r.stdout.strip()), (0, ""))


if __name__ == "__main__":
    unittest.main()
