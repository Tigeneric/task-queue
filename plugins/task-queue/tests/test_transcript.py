"""A session's transcript is found by its id, not by the directory it runs in now.

Claude Code keeps a transcript under the slug of the directory the session STARTED in; a session
that later moves (`cd` to another project) keeps writing there, while ~/.claude/sessions/<pid>.json
carries the new cwd. Every reader that turned the current cwd into a slug lost such a session
silently: bin/contexts dropped it from the companions list, bin/stalls never saw it stop, and the
stale-cache guard never saw its cache cool.

Run: python3 -I plugins/task-queue/tests/test_transcript.py
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PLUGINS = Path(__file__).resolve().parent.parent.parent
CONTEXTS = PLUGINS / "task-queue" / "bin" / "contexts"
STALLS = PLUGINS / "task-queue" / "bin" / "stalls"
GUARD = PLUGINS / "stale-cache-guard" / "bin" / "stale-cache-guard.py"

# Every place that turns a session into its transcript path; a new one must join this test.
READERS = {"task-queue/bin/contexts", "task-queue/bin/stalls", "stale-cache-guard/bin/stale-cache-guard.py"}


class MovedSession(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.home = Path(self.dir.name)
        sessions = self.home / ".claude" / "sessions"
        sessions.mkdir(parents=True)
        # Started in /work/first, now in /work/second: the transcript stays under the first slug.
        (sessions / "7.json").write_text(json.dumps({"pid": 7, "name": "Mover🕯️", "sessionId": "sid-7",
                                                     "cwd": "/work/second"}))
        started = self.home / ".claude" / "projects" / "-work-first"
        started.mkdir(parents=True)
        (self.home / ".claude" / "projects" / "-work-second").mkdir()
        self.transcript = started / "sid-7.jsonl"
        usage = {"input_tokens": 10, "cache_read_input_tokens": 499_990, "cache_creation_input_tokens": 0}
        # Compact separators, as Claude Code writes them: bin/contexts matches '"type":"assistant"' as text.
        self.transcript.write_text(json.dumps({"type": "assistant", "timestamp": "2026-11-03T10:00:00Z",
                                               "message": {"role": "assistant", "content": [], "usage": usage}},
                                              separators=(",", ":")) + "\n")

    def tearDown(self):
        self.dir.cleanup()

    def env(self, **extra):
        return {"HOME": str(self.home), "PATH": os.environ.get("PATH", ""), **extra}

    def test_contexts_lists_the_session(self):
        r = subprocess.run([sys.executable, "-I", str(CONTEXTS)], capture_output=True, text=True,
                           env=self.env(QUEUE_STALE_GUARD=str(GUARD)))
        self.assertEqual(json.loads(r.stdout).get("Mover", {}).get("tokens"), 500_000, r.stderr)

    def test_stalls_points_at_the_transcript(self):
        code = ("import sys, importlib.util; from importlib.machinery import SourceFileLoader as L; "
                "l = L('stalls', sys.argv[1]); m = importlib.util.module_from_spec(importlib.util.spec_from_loader('stalls', l)); "
                "l.exec_module(m); print(m.sessions()['Mover'])")
        r = subprocess.run([sys.executable, "-I", "-c", code, str(STALLS)], capture_output=True, text=True,
                           env=self.env())
        self.assertEqual(r.stdout.strip(), str(self.transcript), r.stderr)

    def test_the_guard_reports_its_idle_time(self):
        r = subprocess.run([sys.executable, "-I", str(GUARD), "--status"], capture_output=True, text=True,
                           stdin=subprocess.DEVNULL, env=self.env(GUARD_NOW="1793710800"))
        self.assertEqual(json.loads(r.stdout).get("Mover", {}).get("tokens"), 500_000, r.stderr)

    def test_a_session_without_a_transcript_is_still_skipped(self):
        self.transcript.unlink()
        r = subprocess.run([sys.executable, "-I", str(CONTEXTS)], capture_output=True, text=True,
                           env=self.env(QUEUE_STALE_GUARD=str(GUARD)))
        self.assertEqual(json.loads(r.stdout), {}, r.stderr)


class EveryReaderIsCovered(unittest.TestCase):
    def test_the_set_of_path_builders_has_not_changed(self):
        found = set()
        for path in PLUGINS.glob("*/bin/*"):
            text = path.read_text(errors="replace") if path.is_file() else ""
            if "sessionId" in text and ".claude/projects" in text:
                found.add(str(path.relative_to(PLUGINS)))
        self.assertTrue(found, "the scan finds the readers at all")
        self.assertEqual(found, READERS, "a new reader of session transcripts: give it the by-id lookup and a case here")


if __name__ == "__main__":
    unittest.main()
