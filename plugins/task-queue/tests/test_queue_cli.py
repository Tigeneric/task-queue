"""The queue CLI, run as Claude runs it: a subprocess over a real file.

Run: python3 -I plugins/task-queue/tests/test_queue_cli.py
"""

import json
import shutil
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path

MOD = Path(__file__).resolve().parent.parent
CLI = MOD / "bin" / "queue"


def run(*args, env=None):
    return subprocess.run([sys.executable, "-I", str(CLI), *args], capture_output=True, text=True, env=env)


class QueueCli(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = str(Path(self.dir.name) / "q.json")

    def tearDown(self):
        self.dir.cleanup()

    def q(self, *args):
        result = run("--file", self.path, *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def load(self):
        return json.loads(Path(self.path).read_text())

    def test_why_records_and_clears_a_sessions_idle_reason_by_bare_name(self):
        self.q("new", "t")
        self.q("why", "Lin-Yao🏚️", "ждёт решения по #12")
        self.assertEqual(self.load()["why"], {"Lin-Yao": "ждёт решения по #12"})
        self.q("why", "Lin-Yao", "")
        self.assertNotIn("why", self.load())

    def test_coordinator_mode_is_set_shown_and_cleared(self):
        self.q("new", "t")
        self.assertNotIn("coordinator", self.load())
        self.assertNotIn("coordinator", self.q("show"))
        self.q("coordinator", "on")
        self.assertIs(self.load()["coordinator"], True)
        self.assertIn("coordinator: on", self.q("show").splitlines())
        self.q("coordinator", "off")
        self.assertNotIn("coordinator", self.load())
        self.assertNotIn("coordinator", self.q("show"))

    def test_new_writes_title_purpose_and_time(self):
        self.q("new", "release", "--purpose", "Заметки к выпуску")
        q = self.load()
        self.assertEqual((q["title"], q["purpose"], q["tasks"]), ("release", "Заметки к выпуску", []))
        self.assertRegex(q["updated"], r"^\d\d:\d\d$")

    def test_new_on_an_existing_queue_keeps_its_tasks(self):
        self.q("new", "a")
        self.q("add", "one")
        self.q("new", "b")
        self.assertEqual((self.load()["title"], len(self.load()["tasks"])), ("b", 1))

    def test_add_numbers_after_the_highest_and_defaults_to_mine_waiting(self):
        self.q("new", "t")
        self.assertEqual(self.q("add", "one"), "#1")
        self.q("add", "two", "--owner", "ты", "--status", "active")
        q = self.load()
        q["tasks"] = [t for t in q["tasks"] if t["n"] != 1]
        Path(self.path).write_text(json.dumps(q))
        self.assertEqual(self.q("add", "three"), "#3")
        tasks = {t["n"]: t for t in self.load()["tasks"]}
        self.assertEqual(tasks[2], {"n": 2, "task": "two", "owner": "ты", "status": "active"})
        self.assertEqual(tasks[3], {"n": 3, "task": "three", "owner": "me", "status": "waiting"})

    def test_status_verbs_change_only_the_named_tasks(self):
        self.q("new", "t")
        for name in "abcd":
            self.q("add", name)
        self.q("done", "1", "3")
        self.q("start", "2")
        self.q("fail", "4")
        self.q("wait", "3")
        statuses = [t["status"] for t in self.load()["tasks"]]
        self.assertEqual(statuses, ["done", "active", "waiting", "failed"])

    def test_an_unknown_task_fails_and_leaves_the_file_as_it_was(self):
        self.q("new", "t")
        self.q("add", "a")
        before = Path(self.path).read_bytes()
        result = run("--file", self.path, "done", "1", "7")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("#7", result.stderr)
        self.assertEqual(Path(self.path).read_bytes(), before)

    def test_set_renames_and_reassigns(self):
        self.q("new", "t")
        self.q("add", "a")
        self.q("set", "1", "--task", "b", "--owner", "субагент Explore")
        self.assertEqual(self.load()["tasks"][0], {"n": 1, "task": "b", "owner": "субагент Explore", "status": "waiting"})

    def test_ask_and_answer_by_the_number_the_pane_shows(self):
        self.q("new", "t")
        self.assertEqual(self.q("ask", "first?"), "?1")
        self.assertEqual(self.q("ask", "second?", "--blocks", "16", "19"), "?2")
        self.assertEqual(self.load()["questions"][1], {"q": "second?", "blocks": [16, 19]})
        self.q("answer", "1")
        self.assertEqual([one["q"] for one in self.load()["questions"]], ["second?"])
        self.q("answer", "1")
        self.assertNotIn("questions", self.load())

    def test_an_unknown_question_fails_and_leaves_the_questions(self):
        self.q("new", "t")
        self.q("ask", "first?")
        result = run("--file", self.path, "answer", "2")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("?2", result.stderr)
        self.assertEqual(self.load()["questions"], [{"q": "first?"}])

    def test_a_question_written_as_a_plain_string_shows(self):
        self.q("new", "t")
        q = self.load()
        q["questions"] = ["plain?"]
        Path(self.path).write_text(json.dumps(q))
        result = run("--file", self.path, "show")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("?1 plain?", result.stdout)

    def test_text_fields_set_and_clear(self):
        self.q("new", "t")
        self.q("phase", "ждём сборку")
        self.q("note", "n")
        self.assertEqual((self.load()["phase"], self.load()["note"]), ("ждём сборку", "n"))
        self.q("phase", "")
        self.assertNotIn("phase", self.load())

    def test_cyrillic_is_written_as_is(self):
        self.q("new", "отток")
        self.assertIn("отток", Path(self.path).read_text())

    def test_without_a_queue_it_says_to_start_one(self):
        result = run("--file", self.path, "add", "a")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("start one with `queue new", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse(Path(self.path).exists())

    def test_the_default_file_is_the_sessions_queue(self):
        env = {"HOME": self.dir.name, "CLAUDE_CODE_SESSION_ID": "sess-1", "PATH": os.environ["PATH"]}
        result = run("new", "t", env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((Path(self.dir.name) / ".claude/task-queues/sess-1.json").exists())

    def test_the_status_verbs_cover_every_status_the_pane_draws(self):
        # The statuses live in the pane's type contract; a new one there needs a verb here.
        contract = (MOD / "types/index.d.ts").read_text()
        union = re.search(r"status: ([^}]+?) }", contract).group(1)
        statuses = set(re.findall(r"'(\w+)'", union))
        self.assertGreaterEqual(len(statuses), 4)
        self.q("new", "t")
        self.q("add", "a")
        seen = set()
        for verb in ("done", "start", "wait", "fail"):
            self.q(verb, "1")
            seen.add(self.load()["tasks"][0]["status"])
        self.assertEqual(seen, statuses)



    def test_an_owner_that_is_not_one_session_name_is_warned_about(self):
        self.q("new", "t")
        result = run("--file", self.path, "--lang", "ru", "add", "a", "--owner", "сессия X → оператор")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("queue: warning: «сессия X → оператор»", result.stderr)
        self.assertEqual(self.load()["tasks"][0]["owner"], "сессия X → оператор")
        result = run("--file", self.path, "--lang", "ru", "set", "1", "--owner", "сессия «A» + «B»")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("queue: warning: «сессия «A» + «B»»", result.stderr)

    def test_one_session_name_with_or_without_its_badge_passes_quietly(self):
        self.q("new", "t")
        for owner in ("сессия Ada", "сессия Mary Ann🗡️", "сессия O'Brien-Smith", "ты", "субагент → Explore"):
            result = run("--file", self.path, "add", "a", "--owner", owner)
            self.assertEqual((result.returncode, result.stderr), (0, ""), owner)

    def test_park_marks_a_task_and_done_clears_it(self):
        self.q("new", "t")
        self.q("add", "Ada: merge", "--owner", "сессия Ada", "--status", "active")
        self.q("park", "1")
        self.assertIs(self.load()["tasks"][0].get("parked"), True)
        self.assertEqual(self.load()["tasks"][0]["status"], "active")
        self.q("unpark", "1")
        self.assertNotIn("parked", self.load()["tasks"][0])
        self.q("park", "1")
        self.q("done", "1")
        self.assertNotIn("parked", self.load()["tasks"][0])

    def test_under_lang_ru_the_default_owner_is_ya(self):
        self.q("--lang", "ru", "new", "t")
        self.q("--lang", "ru", "add", "one")
        self.assertEqual(self.load()["tasks"][0]["owner"], "я")
        self.q("add", "two")
        self.assertEqual(self.load()["tasks"][1]["owner"], "me")

    def test_under_lang_en_the_owner_warning_is_english(self):
        self.q("new", "t")
        result = run("--file", self.path, "--lang", "en", "add", "a", "--owner", "session X → operator")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('queue: warning: "session X → operator" is not one session\'s name', result.stderr)
        self.assertIn("write `session <name>`", result.stderr)
        self.assertNotRegex(result.stderr, "[А-Яа-яЁё«»]")

    def test_an_english_session_owner_with_its_badge_passes_quietly(self):
        self.q("new", "t")
        for owner in ("session Ada", "session Mary Ann🗡️", "me", "you", "bg", "subagent → Explore"):
            result = run("--file", self.path, "--lang", "en", "add", "a", "--owner", owner)
            self.assertEqual((result.returncode, result.stderr), (0, ""), owner)

class Contexts(unittest.TestCase):
    """bin/contexts marks a session cold exactly when the stale-cache guard says so."""

    def test_cold_comes_from_the_guard(self):
        with tempfile.TemporaryDirectory() as home:
            h = Path(home)
            (h / ".claude/sessions").mkdir(parents=True)
            for pid, name, sid in ((1, "Coldy🎻", "s1"), (2, "Warmy🏚️", "s2")):
                (h / f".claude/sessions/{pid}.json").write_text(json.dumps({"name": name, "sessionId": sid, "cwd": "/w"}))
                t = h / ".claude/projects/-w" / f"{sid}.jsonl"
                t.parent.mkdir(parents=True, exist_ok=True)
                t.write_text(json.dumps({"type": "assistant", "message": {"usage": {"input_tokens": 1, "cache_read_input_tokens": 500000}}}, separators=(",", ":")) + "\n")
            guard = h / "guard.py"
            guard.write_text('import json; print(json.dumps({"Coldy": {"cold": True, "idle_s": 5400, "allowed": True}, "Warmy": {"cold": False, "idle_s": 4000}}))\n')
            env = {**os.environ, "HOME": home, "QUEUE_STALE_GUARD": str(guard)}
            out = subprocess.run([sys.executable, "-I", str(MOD / "bin" / "contexts")], capture_output=True, text=True, env=env)
            d = json.loads(out.stdout)
            self.assertTrue(d["Coldy"].get("cold"), d)
            self.assertEqual(d["Coldy"].get("idle_s"), 5400, d)
            self.assertIs(d["Coldy"].get("allowed"), True, d)
            self.assertNotIn("cold", d["Warmy"], d)
            self.assertEqual(d["Warmy"].get("idle_s"), 4000, d)  # idle comes through for every session
            env["QUEUE_STALE_GUARD"] = str(h / "missing.py")
            d = json.loads(subprocess.run([sys.executable, "-I", str(MOD / "bin" / "contexts")], capture_output=True, text=True, env=env).stdout)
            self.assertNotIn("cold", d["Coldy"], d)

    def test_the_guard_is_found_beside_an_installed_copy(self):
        # Installed, each plugin is cached as <marketplace>/<plugin>/<version>/: the guard is
        # then two levels up and under its own version, the newest one counting.
        with tempfile.TemporaryDirectory() as home:
            h = Path(home)
            (h / ".claude/sessions").mkdir(parents=True)
            (h / ".claude/sessions/1.json").write_text(json.dumps({"name": "Coldy🎻", "sessionId": "s1", "cwd": "/w"}))
            t = h / ".claude/projects/-w/s1.jsonl"
            t.parent.mkdir(parents=True)
            t.write_text(json.dumps({"type": "assistant", "message": {"usage": {"input_tokens": 1, "cache_read_input_tokens": 500000}}}, separators=(",", ":")) + "\n")
            market = h / "cache" / "mk"
            shutil.copytree(MOD / "bin", market / "task-queue" / "0.4.0" / "bin")
            for version, cold in (("0.9.0", False), ("0.10.0", True)):
                g = market / "stale-cache-guard" / version / "bin" / "stale-cache-guard.py"
                g.parent.mkdir(parents=True)
                g.write_text(f'import json; print(json.dumps({{"Coldy": {{"cold": {cold}, "idle_s": 5400}}}}))\n')
            contexts = market / "task-queue" / "0.4.0" / "bin" / "contexts"
            env = {k: v for k, v in os.environ.items() if k != "QUEUE_STALE_GUARD"}
            env["HOME"] = home
            d = json.loads(subprocess.run([sys.executable, "-I", str(contexts)], capture_output=True, text=True, env=env).stdout)
            self.assertIs(d["Coldy"].get("cold"), True, "the newest installed guard decides")
            found = subprocess.run([sys.executable, "-I", str(contexts), "--guard"], capture_output=True, text=True, env=env)
            self.assertEqual((found.returncode, found.stdout.strip()),
                             (0, str((market / "stale-cache-guard" / "0.10.0" / "bin" / "stale-cache-guard.py").resolve())))

    def test_with_no_guard_anywhere_guard_lookup_fails(self):
        with tempfile.TemporaryDirectory() as home:
            alone = Path(home) / "cache" / "mk" / "task-queue" / "0.4.0" / "bin"
            shutil.copytree(MOD / "bin", alone)
            env = {k: v for k, v in os.environ.items() if k != "QUEUE_STALE_GUARD"}
            env["HOME"] = home
            found = subprocess.run([sys.executable, "-I", str(alone / "contexts"), "--guard"], capture_output=True, text=True, env=env)
            self.assertEqual((found.returncode, found.stdout), (1, ""))

    def test_a_compact_after_the_last_call_resets_the_fill(self):
        with tempfile.TemporaryDirectory() as home:
            h = Path(home)
            (h / ".claude/sessions").mkdir(parents=True)
            (h / ".claude/sessions/1.json").write_text(json.dumps({"name": "Squeezed🎻", "sessionId": "s1", "cwd": "/w"}))
            call = {"type": "assistant", "message": {"usage": {"input_tokens": 1, "cache_read_input_tokens": 650000}}}
            boundary = {"type": "system", "subtype": "compact_boundary"}
            t = h / ".claude/projects/-w/s1.jsonl"
            t.parent.mkdir(parents=True)
            t.write_text("".join(json.dumps(x, separators=(",", ":")) + "\n" for x in (call, boundary)))
            env = {**os.environ, "HOME": home, "QUEUE_STALE_GUARD": str(h / "none.py")}
            d = json.loads(subprocess.run([sys.executable, "-I", str(MOD / "bin" / "contexts")],
                                          capture_output=True, text=True, env=env).stdout)
            self.assertEqual(d["Squeezed"]["pct"], 0, d)

    def compacted_with_marker(self, home, marker_age, text="keep the review state\n"):
        """A session whose newest compact_boundary is 600 s old, and a ready marker `marker_age` s old."""
        h = Path(home)
        (h / ".claude/sessions").mkdir(parents=True)
        (h / ".claude/sessions/1.json").write_text(json.dumps({"name": "Squeezed🎻", "sessionId": "s1", "cwd": "/w"}))
        now = time.time()
        stamp = lambda ago: time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(now - ago))
        call = {"type": "assistant", "timestamp": stamp(900), "message": {"usage": {"input_tokens": 1, "cache_read_input_tokens": 650000}}}
        boundary = {"type": "system", "subtype": "compact_boundary", "timestamp": stamp(600)}
        after = {"type": "assistant", "timestamp": stamp(300), "message": {"usage": {"input_tokens": 1, "cache_read_input_tokens": 40000}}}
        t = h / ".claude/projects/-w/s1.jsonl"
        t.parent.mkdir(parents=True)
        t.write_text("".join(json.dumps(x, separators=(",", ":")) + "\n" for x in (call, boundary, after)))
        marker = h / ".claude/task-queues/compact-ready/Squeezed.txt"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(text)
        os.utime(marker, (now - marker_age, now - marker_age))
        env = {**os.environ, "HOME": home, "QUEUE_STALE_GUARD": str(h / "none.py")}
        d = json.loads(subprocess.run([sys.executable, "-I", str(MOD / "bin" / "contexts")],
                                      capture_output=True, text=True, env=env).stdout)
        return d, marker

    def test_a_ready_marker_older_than_the_last_compact_is_removed_and_not_shown(self):
        with tempfile.TemporaryDirectory() as home:
            d, marker = self.compacted_with_marker(home, marker_age=1200)
            self.assertNotIn("compact", d["Squeezed"], d)
            self.assertFalse(marker.exists())

    def test_a_ready_marker_written_after_the_last_compact_is_kept(self):
        with tempfile.TemporaryDirectory() as home:
            d, marker = self.compacted_with_marker(home, marker_age=60)
            self.assertEqual(d["Squeezed"].get("compact"), "keep the review state", d)
            self.assertTrue(marker.exists())

    def test_a_marker_written_for_the_session_names_its_author_and_drops_the_header(self):
        with tempfile.TemporaryDirectory() as home:
            env = {**os.environ, "HOME": home}
            out = subprocess.run([sys.executable, "-I", str(MOD / "bin" / "queue"), "--file", f"{home}/none.json",
                                  "compact-for", "Squeezed🎻", "  resume from NOTE.md  ", "--by", "Urra"],
                                 capture_output=True, text=True, env=env)
            self.assertEqual(out.returncode, 0, out.stderr)
            marker = Path(home) / ".claude/task-queues/compact-ready/Squeezed.txt"
            self.assertEqual(out.stdout.strip(), str(marker))
            self.assertEqual(marker.read_text(), "<!-- by Urra -->\nresume from NOTE.md\n")
            d, _ = self.compacted_with_marker(home, marker_age=60, text=marker.read_text())
            self.assertEqual(d["Squeezed"].get("compact"), "resume from NOTE.md", d)
            self.assertEqual(d["Squeezed"].get("compact_by"), "Urra", d)

    def test_a_marker_the_session_wrote_itself_has_no_author(self):
        with tempfile.TemporaryDirectory() as home:
            d, _ = self.compacted_with_marker(home, marker_age=60)
            self.assertNotIn("compact_by", d["Squeezed"], d)

    def test_queue_marks_a_stalled_session(self):
        with tempfile.TemporaryDirectory() as home:
            h = Path(home)
            (h / ".claude/sessions").mkdir(parents=True)
            (h / ".claude/sessions/1.json").write_text(json.dumps({"name": "Idle🏚️", "sessionId": "s1", "cwd": "/w"}))
            ts = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() - 1200))
            line = {"type": "assistant", "timestamp": ts, "message": {"content": [{"type": "text", "text": "done"}],
                    "usage": {"input_tokens": 1, "cache_read_input_tokens": 100000}}}
            t = h / ".claude/projects/-w/s1.jsonl"
            t.parent.mkdir(parents=True)
            t.write_text(json.dumps(line, separators=(",", ":")) + "\n")
            q = h / "q.json"
            q.write_text(json.dumps({"tasks": [{"n": 1, "task": "x", "owner": "сессия Idle", "status": "active"}]}))
            env = {**os.environ, "HOME": home, "QUEUE_STALE_GUARD": str(h / "none.py")}
            out = subprocess.run([sys.executable, "-I", str(MOD / "bin" / "contexts"), "--queue", str(q)],
                                 capture_output=True, text=True, env=env)
            self.assertIs(json.loads(out.stdout)["Idle"].get("stalled"), True, out.stdout + out.stderr)

    def test_queue_limits_the_reading_to_its_sessions(self):
        with tempfile.TemporaryDirectory() as home:
            h = Path(home)
            (h / ".claude/sessions").mkdir(parents=True)
            line = json.dumps({"type": "assistant", "timestamp": "2026-10-20T10:00:00.000Z",
                               "message": {"content": [], "usage": {"input_tokens": 1}}}, separators=(",", ":"))
            for pid, name in ((1, "Mine🏚️"), (2, "Stranger📜")):
                (h / f".claude/sessions/{pid}.json").write_text(json.dumps({"name": name, "sessionId": f"s{pid}", "cwd": "/w"}))
                t = h / ".claude/projects/-w" / f"s{pid}.jsonl"
                t.parent.mkdir(parents=True, exist_ok=True)
                t.write_text(line + "\n")
            q = h / "q.json"
            q.write_text(json.dumps({"tasks": [{"n": 1, "task": "x", "owner": "сессия Mine", "status": "done"}]}))
            env = {**os.environ, "HOME": home, "QUEUE_STALE_GUARD": str(h / "none.py")}
            d = json.loads(subprocess.run([sys.executable, "-I", str(MOD / "bin" / "contexts"), "--queue", str(q)],
                                          capture_output=True, text=True, env=env).stdout)
            self.assertIn("Mine", d)
            self.assertNotIn("Stranger", d)

class SessionNames(unittest.TestCase):
    """One rule turns an owner into the session's key: the pane's sessionName, bin/stalls and
    bin/contexts through it. A roster badge written with the name is dropped."""

    def test_the_pane_keeps_the_same_characters_as_bin_stalls(self):
        pane = (MOD / "hooks/register.tsx").read_text()
        rule = re.search(r"function sessionName\(owner: string\): string \{\n(.*?)\n\}", pane, re.S).group(1)
        self.assertIn(r"filter(ch => /[\p{L}\p{N} '-]/u.test(ch))", rule)
        stalls = (MOD / "bin/stalls").read_text()
        self.assertIn("""ch.isalnum() or ch in " '-\"""", re.search(r"def bare\(name\):\n(.*?)\n\n", stalls, re.S).group(1))

    def test_a_badge_written_with_the_owner_is_dropped_everywhere(self):
        with tempfile.TemporaryDirectory() as home:
            h = Path(home)
            (h / ".claude/sessions").mkdir(parents=True)
            (h / ".claude/sessions/1.json").write_text(json.dumps({"name": "Mary Ann🗡️", "sessionId": "s1", "cwd": "/w"}))
            ts = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() - 1200))
            line = {"type": "assistant", "timestamp": ts, "message": {"content": [{"type": "text", "text": "done"}],
                    "usage": {"input_tokens": 1, "cache_read_input_tokens": 100000}}}
            t = h / ".claude/projects/-w/s1.jsonl"
            t.parent.mkdir(parents=True)
            t.write_text(json.dumps(line, separators=(",", ":")) + "\n")
            q = h / "q.json"
            q.write_text(json.dumps({"tasks": [{"n": 1, "task": "x", "owner": "сессия Mary Ann🗡️", "status": "active"}]}))
            env = {**os.environ, "HOME": home, "QUEUE_STALE_GUARD": str(h / "none.py")}
            out = subprocess.run([sys.executable, "-I", str(MOD / "bin" / "contexts"), "--queue", str(q)],
                                 capture_output=True, text=True, env=env)
            self.assertEqual(list(json.loads(out.stdout)), ["Mary Ann"], out.stdout + out.stderr)
            self.assertIs(json.loads(out.stdout)["Mary Ann"].get("stalled"), True, out.stdout)


class OwnerWords(unittest.TestCase):
    """bin/stalls reads a session owner in either language, whatever the pane's language."""

    def test_session_name_reads_both_languages(self):
        stalls = SourceFileLoader("stalls_words", str(MOD / "bin" / "stalls")).load_module()
        self.assertEqual(stalls.session_name("сессия Ada🎻"), "Ada")
        self.assertEqual(stalls.session_name("session Ada🎻"), "Ada")
        self.assertEqual(stalls.session_name("Session O'Brien"), "O'Brien")
        self.assertIsNone(stalls.session_name("sessions"))
        self.assertIsNone(stalls.session_name("me"))


class Stalls(unittest.TestCase):
    """bin/stalls: a live task, an ended turn, idle inside the cache hour."""

    T0 = 1790000000

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        h = Path(self.dir.name)
        self.env = {**os.environ, "STALLS_SESSIONS": str(h / "sessions"), "STALLS_PROJECTS": str(h / "projects"),
                    "STALLS_STATE": str(h / "state.json"), "STALLS_NOW": str(self.T0)}
        (h / "sessions").mkdir()
        self.h = h
        self.tasks = []

    def tearDown(self):
        self.dir.cleanup()

    def peer(self, pid, name, last, ago):
        """A session whose last main-thread message is `last` (text | tool | user), `ago` seconds old."""
        sid = f"s{pid}"
        (self.h / "sessions" / f"{pid}.json").write_text(json.dumps({"name": name, "sessionId": sid, "cwd": "/w"}))
        ts = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(self.T0 - ago))
        if last == "user":
            line = {"type": "user", "timestamp": ts, "message": {"content": "hi"}}
        else:
            part = {"type": "tool_use", "name": "Bash"} if last == "tool" else {"type": "text", "text": "done"}
            line = {"type": "assistant", "timestamp": ts, "message": {"content": [part]}}
        t = self.h / "projects" / "-w" / f"{sid}.jsonl"
        t.parent.mkdir(parents=True, exist_ok=True)
        t.write_text(json.dumps(line, separators=(",", ":")) + "\n")

    def run_stalls(self, queue, *args, timeout=20):
        q = self.h / "q.json"
        q.write_text(json.dumps(queue))
        r = subprocess.run([sys.executable, "-I", str(MOD / "bin" / "stalls"), "--file", str(q), *args],
                           capture_output=True, text=True, env=self.env, timeout=timeout)
        return r

    def found(self, queue):
        return json.loads(self.run_stalls(queue, "--json").stdout)

    def task(self, n, owner, status="active", **kw):
        return {"n": n, "task": "x", "owner": owner, "status": status, **kw}

    def test_an_ended_turn_inside_the_hour_is_a_stall(self):
        self.peer(1, "Idle🏚️", "text", 1200)
        self.assertEqual(self.found({"tasks": [self.task(5, "сессия Idle")]})["Idle"]["tasks"], [5])

    def test_a_running_tool_or_an_answered_prompt_is_not(self):
        self.peer(1, "Shell", "tool", 1200)
        self.peer(2, "Asked", "user", 1200)
        self.assertEqual(self.found({"tasks": [self.task(1, "сессия Shell"), self.task(2, "сессия Asked")]}), {})

    def test_too_fresh_or_past_the_cache_hour_is_not(self):
        self.peer(1, "Fresh", "text", 300)
        self.peer(2, "Cold", "text", 4000)
        self.assertEqual(self.found({"tasks": [self.task(1, "сессия Fresh"), self.task(2, "сессия Cold")]}), {})

    def test_parked_waiting_or_asked_tasks_do_not_count(self):
        for pid, name in ((1, "Parked"), (2, "Later"), (3, "Owed")):
            self.peer(pid, name, "text", 1200)
        q = {"tasks": [self.task(1, "сессия Parked", parked=True), self.task(2, "сессия Later", status="waiting"),
                       self.task(3, "сессия Owed")],
             "questions": [{"q": "?", "blocks": [3]}]}
        # A waiting task is not a stall; it is next work, reported as its own kind.
        self.assertEqual({n: s["kind"] for n, s in self.found(q).items()}, {"Later": "next"})

    def test_a_question_written_as_a_plain_string_blocks_nothing(self):
        self.peer(1, "Idle", "text", 1200)
        r = self.run_stalls({"tasks": [self.task(5, "сессия Idle")], "questions": ["plain?"]}, "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["Idle"]["tasks"], [5])

    def test_wait_reports_a_stall_once(self):
        self.peer(1, "Idle", "text", 1200)
        q = {"tasks": [self.task(5, "сессия Idle")]}
        self.assertIn("Idle", self.run_stalls(q, "--wait").stdout)
        with self.assertRaises(subprocess.TimeoutExpired):
            self.run_stalls(q, "--wait", timeout=3)

    def test_a_free_session_with_waiting_work_of_its_own_is_reported_as_next(self):
        self.peer(1, "Free🏚️", "text", 1200)
        q = {"tasks": [self.task(7, "сессия Free", status="waiting"), self.task(6, "сессия Free", status="waiting"),
                       self.task(5, "сессия Free", status="done"), self.task(8, "сессия Other", status="waiting")]}
        self.assertEqual(self.run_stalls(q).stdout, "Free: 20 min idle, next: #6, #7\n")

    def test_json_tells_next_from_stalled_and_keeps_the_stalled_keys(self):
        self.peer(1, "Idle", "text", 1200)
        self.peer(2, "Free", "text", 1200)
        q = {"tasks": [self.task(5, "сессия Idle"), self.task(9, "сессия Idle", status="waiting"),
                       self.task(6, "сессия Free", status="waiting")]}
        found = self.found(q)
        self.assertEqual({k: found["Idle"][k] for k in ("idle_s", "tasks", "since", "kind")},
                         {"idle_s": 1200, "tasks": [5], "since": self.T0 - 1200, "kind": "stalled"})
        self.assertEqual((found["Free"]["kind"], found["Free"]["tasks"]), ("next", [6]))

    def test_parked_or_asked_waiting_work_is_not_next(self):
        self.peer(1, "Parked", "text", 1200)
        self.peer(2, "Owed", "text", 1200)
        q = {"tasks": [self.task(6, "сессия Parked", status="waiting", parked=True),
                       self.task(7, "сессия Owed", status="waiting")],
             "questions": [{"q": "?", "blocks": [7]}]}
        self.assertEqual(self.run_stalls(q).stdout, "")

    def test_parked_waiting_work_is_left_out_of_a_next_line(self):
        self.peer(1, "Free", "text", 1200)
        q = {"tasks": [self.task(6, "сессия Free", status="waiting", parked=True),
                       self.task(7, "сессия Free", status="waiting")]}
        self.assertEqual(self.run_stalls(q).stdout, "Free: 20 min idle, next: #7\n")

    WHY = {"tasks": [{"n": 5, "task": "x", "owner": "сессия Idle", "status": "active"},
                     {"n": 6, "task": "x", "owner": "сессия Free", "status": "waiting"}],
           "why": {"Idle": "ждёт решения владельца", "Free": "холодный кеш"}}

    def test_a_recorded_why_is_shown_on_the_line_and_silences_nothing(self):
        self.peer(1, "Idle", "text", 1200)
        self.peer(2, "Free", "text", 1200)
        self.assertEqual(self.run_stalls(self.WHY).stdout,
                         "Free: 20 min idle, next: #6 — why: холодный кеш\n"
                         "Idle: 20 min idle with #5 — why: ждёт решения владельца\n")

    def test_a_recorded_why_is_in_the_json(self):
        self.peer(1, "Idle", "text", 1200)
        self.peer(2, "Free", "text", 1200)
        found = self.found(self.WHY)
        self.assertEqual((found["Idle"].get("why"), found["Free"].get("why")),
                         ("ждёт решения владельца", "холодный кеш"))

    def test_wait_wakes_on_next_after_a_stall_of_the_same_turn(self):
        self.peer(1, "Idle", "text", 1200)
        self.assertIn("with #5", self.run_stalls({"tasks": [self.task(5, "сессия Idle")]}, "--wait").stdout)
        q = {"tasks": [self.task(5, "сессия Idle", status="done"), self.task(6, "сессия Idle", status="waiting")]}
        self.assertEqual(self.run_stalls(q, "--wait").stdout, "Idle: 20 min idle, next: #6\n")
        with self.assertRaises(subprocess.TimeoutExpired):
            self.run_stalls(q, "--wait", timeout=3)

    def test_wait_wakes_on_a_stall_after_next_of_the_same_turn(self):
        self.peer(1, "Idle", "text", 1200)
        self.assertIn("next: #6", self.run_stalls({"tasks": [self.task(6, "сессия Idle", status="waiting")]},
                                                  "--wait").stdout)
        q = {"tasks": [self.task(6, "сессия Idle")]}
        self.assertEqual(self.run_stalls(q, "--wait").stdout, "Idle: 20 min idle with #6\n")

    # --coordinator: the Stop hook's one-shot run, with what it told remembered beside the queue.
    def coord(self, queue, now=None, ps=None):
        q = self.h / "q.json"
        # What `ps` shows: by default the coordinator's own background watcher on this queue.
        (self.h / "ps.txt").write_text(f"python3 /x/bin/stalls --file {q} --wait\n" if ps is None else ps)
        env = {**self.env, "STALLS_PS": str(self.h / "ps.txt"), **({"STALLS_NOW": str(now)} if now else {})}
        q.write_text(json.dumps({"coordinator": True, **queue}))
        return subprocess.run([sys.executable, "-I", str(MOD / "bin" / "stalls"), "--file", str(q), "--coordinator"],
                              capture_output=True, text=True, env=env, timeout=20)

    def test_coordinator_reports_with_the_stalls_wording_and_exit_1(self):
        self.peer(1, "Idle", "text", 1200)
        self.peer(2, "Free", "text", 1200)
        r = self.coord(self.WHY)
        self.assertEqual((r.returncode, r.stdout),
                         (1, "Free: 20 min idle, next: #6 — why: холодный кеш\n"
                             "Idle: 20 min idle with #5 — why: ждёт решения владельца\n"), r.stderr)

    def test_coordinator_is_silent_when_the_queue_is_not_the_coordinators(self):
        self.peer(1, "Idle", "text", 1200)
        q = self.h / "q.json"
        for queue in ({"tasks": [self.task(5, "сессия Idle")]},
                      {"coordinator": False, "tasks": [self.task(5, "сессия Idle")]}):
            q.write_text(json.dumps(queue))
            r = subprocess.run([sys.executable, "-I", str(MOD / "bin" / "stalls"), "--file", str(q), "--coordinator"],
                               capture_output=True, text=True, env=self.env, timeout=20)
            self.assertEqual((r.returncode, r.stdout), (0, ""), queue)

    def test_coordinator_never_reports_parked_or_question_blocked_rows(self):
        for pid, name in ((1, "Parked"), (2, "Owed"), (3, "ParkedNext"), (4, "OwedNext")):
            self.peer(pid, name, "text", 1200)
        q = {"tasks": [self.task(1, "сессия Parked", parked=True), self.task(2, "сессия Owed"),
                       self.task(3, "сессия ParkedNext", status="waiting", parked=True),
                       self.task(4, "сессия OwedNext", status="waiting")],
             "questions": [{"q": "?", "blocks": [2, 4]}]}
        r = self.coord(q)
        self.assertEqual((r.returncode, r.stdout), (0, ""))

    def test_coordinator_tells_a_report_once_while_its_minutes_grow(self):
        self.peer(1, "Idle", "text", 1200)
        q = {"tasks": [self.task(5, "сессия Idle")]}
        self.assertEqual(self.coord(q).stdout, "Idle: 20 min idle with #5\n")
        later = self.coord(q, now=self.T0 + 600)
        self.assertEqual((later.returncode, later.stdout), (0, ""))
        state = json.loads((self.h / ".q.json.coordinator-reported.json").read_text())
        self.assertEqual(state, [f"stalled:Idle:5:{self.T0 - 1200}"])

    def test_coordinator_reports_again_when_the_tasks_or_the_kind_change(self):
        self.peer(1, "Idle", "text", 1200)
        self.coord({"tasks": [self.task(5, "сессия Idle")]})
        q = {"tasks": [self.task(5, "сессия Idle", status="done"), self.task(6, "сессия Idle")]}
        self.assertEqual(self.coord(q).stdout, "Idle: 20 min idle with #6\n")
        q = {"tasks": [self.task(6, "сессия Idle", status="done"), self.task(7, "сессия Idle", status="waiting")]}
        self.assertEqual(self.coord(q).stdout, "Idle: 20 min idle, next: #7\n")

    def test_coordinator_reports_a_stall_that_cleared_and_recurred(self):
        self.peer(1, "Idle", "text", 1200)
        q = {"tasks": [self.task(5, "сессия Idle")]}
        self.coord(q)
        self.peer(1, "Idle", "tool", 1200)  # back at work: the report clears
        self.assertEqual(self.coord(q).stdout, "")
        self.peer(1, "Idle", "text", 1000)  # idle again with the same task
        self.assertEqual(self.coord(q).stdout, "Idle: 16 min idle with #5\n")

    def test_coordinator_reports_a_stall_that_recurred_unseen_between_two_stops(self):
        self.peer(1, "Idle", "text", 1200)
        q = {"tasks": [self.task(5, "сессия Idle")]}
        self.coord(q)
        self.peer(1, "Idle", "text", 1000)  # worked and went idle again before the next stop
        self.assertEqual(self.coord(q).stdout, "Idle: 16 min idle with #5\n")

    def test_coordinator_says_once_that_no_watcher_runs(self):
        q = {"tasks": []}
        other = f"python3 /x/bin/stalls --file {self.h / 'other.json'} --wait\n" \
                f"python3 /x/bin/stalls --file {self.h / 'q.json'} --coordinator\n"
        r = self.coord(q, ps=other)
        self.assertEqual(r.returncode, 1)
        self.assertRegex(r.stdout, r"^watcher: no background `\S+/bin/stalls --file \S+/q\.json --wait` is running")
        self.assertEqual(self.coord(q, ps=other).stdout, "")  # told once while it stays missing

    def test_coordinator_is_quiet_about_a_running_watcher_and_tells_again_after_it_dies(self):
        q = {"tasks": []}
        self.assertEqual((self.coord(q).returncode, self.coord(q).stdout), (0, ""))
        self.assertIn("watcher:", self.coord(q, ps="").stdout)
        self.coord(q)  # relaunched
        self.assertIn("watcher:", self.coord(q, ps="").stdout)  # died again: told again

    # Background work. The shapes are the transcript's own, measured 2026-10-20: the launch is
    # the tool_result's toolUseResult (backgroundTaskId for Bash, isAsync+agentId for Agent,
    # taskId+timeoutMs for Monitor); the completion a <task-notification> with that <task-id>
    # and a <status>, arriving as a user entry, a queued_command attachment or a queue-operation.

    def ts(self, ago):
        return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(self.T0 - ago))

    def prompt(self, ago):
        return {"type": "user", "timestamp": self.ts(ago), "message": {"content": "go"}}

    def said(self, ago):
        return {"type": "assistant", "timestamp": self.ts(ago), "message": {"content": [{"type": "text", "text": "ok"}]}}

    def launched(self, ago, kind, tid):
        result = {"bash": {"backgroundTaskId": tid, "stdout": "", "stderr": "", "interrupted": False},
                  "agent": {"isAsync": True, "status": "async_launched", "agentId": tid},
                  "monitor": {"taskId": tid, "timeoutMs": 3600000, "persistent": False}}[kind]
        text = {"bash": f"Command running in background with ID: {tid}",
                "agent": f"Async agent launched successfully.\nagentId: {tid}",
                "monitor": f"Monitor started (task {tid}, timeout 3600000ms)."}[kind]
        return [{"type": "assistant", "timestamp": self.ts(ago),
                 "message": {"content": [{"type": "tool_use", "id": f"tu{tid}", "name": kind}]}},
                {"type": "user", "timestamp": self.ts(ago), "toolUseResult": result,
                 "sourceToolAssistantUUID": "a", "message": {"content": [
                     {"type": "tool_result", "tool_use_id": f"tu{tid}", "content": text}]}}]

    def notified(self, ago, tid, status="completed", via="user"):
        body = f"<task-notification>\n<task-id>{tid}</task-id>\n" + \
               (f"<status>{status}</status>\n" if status else "<event>line</event>\n") + \
               "<summary>s</summary>\n</task-notification>"
        if via == "attachment":
            return {"type": "attachment", "timestamp": self.ts(ago),
                    "attachment": {"type": "queued_command", "prompt": body}}
        return {"type": "user", "timestamp": self.ts(ago), "origin": {"kind": "task-notification"},
                "message": {"content": body}}

    def peer_lines(self, pid, name, *entries):
        """A session whose transcript is `entries` (dicts or lists of dicts), in order."""
        sid = f"s{pid}"
        (self.h / "sessions" / f"{pid}.json").write_text(json.dumps({"name": name, "sessionId": sid, "cwd": "/w"}))
        flat = [x for e in entries for x in (e if isinstance(e, list) else [e])]
        t = self.h / "projects" / "-w" / f"{sid}.jsonl"
        t.parent.mkdir(parents=True, exist_ok=True)
        t.write_text("".join(json.dumps(x, separators=(",", ":")) + "\n" for x in flat))

    Q = {"tasks": [{"n": 5, "task": "x", "owner": "сессия Bg", "status": "active"}]}

    def test_background_bash_without_completion_is_not_idle(self):
        self.peer_lines(1, "Bg", self.prompt(1300), self.launched(1250, "bash", "b1"), self.said(1200))
        self.assertEqual(self.found(self.Q), {})

    def test_background_bash_with_its_completion_is_idle_as_before(self):
        self.peer_lines(1, "Bg", self.prompt(1300), self.launched(1250, "bash", "b1"), self.said(1240),
                        self.notified(1230, "b1", via="attachment"), self.said(1200))
        self.assertEqual(self.run_stalls(self.Q).stdout, "Bg: 20 min idle with #5\n")

    def test_background_agent_without_completion_is_not_idle(self):
        self.peer_lines(1, "Bg", self.prompt(1300), self.launched(1250, "agent", "a1b2c3"), self.said(1200))
        self.assertEqual(self.found(self.Q), {})

    def test_an_armed_monitor_is_not_idle_and_its_events_do_not_disarm_it(self):
        self.peer_lines(1, "Bg", self.prompt(1300), self.launched(1250, "monitor", "m1"), self.said(1240),
                        self.notified(1230, "m1", status=None), self.said(1200))
        self.assertEqual(self.found(self.Q), {})

    def test_one_completion_does_not_end_the_turn_for_the_other_job(self):
        # The notification for a1 is a user entry; it must not start a new turn and hide b2.
        self.peer_lines(1, "Bg", self.prompt(1300), self.launched(1260, "bash", "a1"),
                        self.launched(1250, "bash", "b2"), self.said(1240),
                        self.notified(1230, "a1"), self.said(1200))
        self.assertEqual(self.found(self.Q), {})

    def test_background_work_pending_past_max_idle_is_idle_again(self):
        self.peer_lines(1, "Bg", self.prompt(4100), self.launched(4000, "bash", "b1"), self.said(1200))
        self.assertEqual(self.run_stalls(self.Q).stdout, "Bg: 20 min idle with #5\n")

    def test_a_background_launch_in_an_earlier_turn_does_not_count(self):
        self.peer_lines(1, "Bg", self.prompt(2000), self.launched(1950, "bash", "b1"), self.said(1900),
                        self.prompt(1300), self.said(1200))
        self.assertEqual(self.run_stalls(self.Q).stdout, "Bg: 20 min idle with #5\n")


if __name__ == "__main__":
    unittest.main()
