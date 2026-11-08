"""bin/unasked, run as the Stop hook runs it: a subprocess over a synthetic transcript and queue.

Run: python3 -I plugins/task-queue/tests/test_unasked.py
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

MOD = Path(__file__).resolve().parent.parent
CLI = MOD / "bin" / "unasked"
LINE = "вопрос оператору не в очереди: queue ask … --blocks …"
LINE_EN = "question to the owner not in the queue: queue ask … --blocks …"
FENCE = "`" * 3


def user(text, **extra):
    return {"type": "user", "isSidechain": False, "message": {"role": "user", "content": text}, **extra}


def results(tool_id="t1"):
    return {"type": "user", "isSidechain": False,
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool_id, "content": "ok"}]}}


def say(text, mid="m-say"):
    return {"type": "assistant", "isSidechain": False,
            "message": {"id": mid, "role": "assistant", "content": [{"type": "text", "text": text}]}}


def bash(command, mid="m-bash"):
    return {"type": "assistant", "isSidechain": False,
            "message": {"id": mid, "role": "assistant",
                        "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": command}}]}}


ASK = 'python3 -I /opt/plugins/task-queue/bin/queue --file q.json ask "Мержим?" --blocks 3'
QUESTION = say("Сделал.\n\nМержим в main?")


class Unasked(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.transcript = Path(self.dir.name) / "t.jsonl"
        self.queue = Path(self.dir.name) / "q.json"
        self.queue.write_text(json.dumps({"title": "t", "tasks": [{"n": 3, "task": "x", "owner": "я", "status": "active"}]}))

    def tearDown(self):
        self.dir.cleanup()

    def run_on(self, entries, *flags, queue=None, stdin=None):
        self.transcript.write_text("".join(
            (e if isinstance(e, str) else json.dumps(e, ensure_ascii=False)) + "\n" for e in entries))
        return subprocess.run([sys.executable, "-I", str(CLI), "--transcript", str(self.transcript),
                               "--file", str(queue or self.queue), *flags], capture_output=True, text=True,
                              input=stdin)

    def assertReported(self, r):
        self.assertEqual((r.returncode, r.stdout, r.stderr), (1, LINE_EN + "\n", ""))

    def assertSilent(self, r):
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))

    # The final text arrives through stdin: Stop can fire before it is written to the transcript

    def test_a_question_given_on_stdin_is_reported_though_the_transcript_lacks_it(self):
        thinking = {"type": "assistant", "isSidechain": False,
                    "message": {"id": "m-say", "role": "assistant", "content": [{"type": "thinking", "thinking": "x"}]}}
        self.assertReported(self.run_on([user("сделай"), thinking], "--last-message-stdin", stdin="Сделал.\n\nМержим?"))

    def test_the_message_on_stdin_wins_over_the_transcripts_last_text(self):
        self.assertSilent(self.run_on([user("сделай"), QUESTION], "--last-message-stdin", stdin="Сделал. Всё влито."))

    def test_an_ask_this_turn_still_covers_a_question_given_on_stdin(self):
        self.assertSilent(self.run_on([user("сделай"), bash(ASK), results()], "--last-message-stdin", stdin="Мержим?"))

    def test_an_empty_stdin_falls_back_to_the_transcript(self):
        self.assertReported(self.run_on([user("сделай"), QUESTION], "--last-message-stdin", stdin=""))

    # A "?" that is not a question: a pointer to a queue question, a quoted question

    def test_a_pointer_to_a_queue_question_is_not_a_question(self):
        self.assertSilent(self.run_on([user("сделай"), say("Сделал.\n\nЖдут твоих ответов ?1 и ?2 в очереди.")]))

    def test_a_question_in_guillemets_is_not_a_question(self):
        self.assertSilent(self.run_on([user("сделай"), say("Сделал.\n\nВ очереди вопрос «Мержим в main?».")]))

    def test_a_question_in_double_quotes_is_not_a_question(self):
        self.assertSilent(self.run_on([user("сделай"), say('Сделал.\n\nХук вернул "вопрос не в очереди?" и замолчал.')]))

    def test_a_real_question_after_a_quote_is_reported(self):
        self.assertReported(self.run_on([user("сделай"), say("Сделал.\n\nВ очереди «?1», а ты что скажешь, мержим?")]))

    # A question at the end of the turn

    def test_a_question_not_put_in_the_queue_is_reported(self):
        self.assertReported(self.run_on([user("сделай"), QUESTION]))

    def test_a_question_asked_through_the_queue_this_turn_is_not_reported(self):
        self.assertSilent(self.run_on([user("сделай"), bash(ASK), results(), QUESTION]))

    def test_an_answer_through_the_queue_this_turn_counts_as_asked(self):
        self.assertSilent(self.run_on([user("сделай"), bash("q() { ~/x/bin/queue --file q.json \"$@\"; }; q answer 2"),
                                       results(), QUESTION]))

    def test_an_ask_in_a_previous_turn_does_not_cover_this_one(self):
        self.assertReported(self.run_on([user("раз"), bash(ASK), results(), say("Спросил."),
                                         user("два"), QUESTION]))

    def test_a_bash_call_on_the_queue_without_ask_or_answer_does_not_count(self):
        self.assertReported(self.run_on([user("сделай"), bash("~/x/bin/queue --file q.json done 3"), results(), QUESTION]))

    def test_ask_without_the_queue_cli_does_not_count(self):
        self.assertReported(self.run_on([user("сделай"), bash("echo ask"), results(), QUESTION]))

    def test_the_last_message_is_read_across_its_split_entries(self):
        # The transcript writes one block per entry; a thinking entry may follow the text.
        thinking = {"type": "assistant", "isSidechain": False,
                    "message": {"id": "m-say", "role": "assistant", "content": [{"type": "thinking", "thinking": "x"}]}}
        self.assertReported(self.run_on([user("сделай"), QUESTION, thinking]))

    # No question

    def test_a_plain_ending_is_silent(self):
        self.assertSilent(self.run_on([user("сделай"), say("Готово. Коммит abc123.")]))

    def test_a_question_mark_inside_a_fenced_block_is_not_a_question(self):
        self.assertSilent(self.run_on([user("сделай"), say(f"Готово:\n\n{FENCE}\nx = a ? b : c\n{FENCE}")]))

    def test_a_question_mark_in_a_fence_spanning_paragraphs_is_not_a_question(self):
        self.assertSilent(self.run_on([user("сделай"), say(f"Вот:\n\n{FENCE}\nif x\n\ny ? 1 : 2\n{FENCE}")]))

    def test_a_question_mark_in_inline_code_is_not_a_question(self):
        self.assertSilent(self.run_on([user("сделай"), say("Готово. Регэксп `a?b` поправлен.")]))

    def test_a_question_mark_in_a_quote_is_not_a_question(self):
        self.assertSilent(self.run_on([user("сделай"), say("Он спросил:\n> А тесты?\nОтветил: да.")]))

    def test_a_question_in_an_earlier_paragraph_only_is_silent(self):
        self.assertSilent(self.run_on([user("сделай"), say("Мержим?\n\nНет, сначала тесты. Делаю.")]))

    # Where the turn starts

    def test_a_tool_result_does_not_start_a_turn(self):
        self.assertSilent(self.run_on([user("сделай"), bash(ASK), results(), bash("ls", mid="m2"), results(),
                                       QUESTION]))

    def test_a_sidechain_user_entry_does_not_start_a_turn(self):
        self.assertSilent(self.run_on([user("сделай"), bash(ASK), results(), user("агент", isSidechain=True),
                                       QUESTION]))

    def test_a_list_with_a_text_block_starts_a_turn(self):
        prompt = {"type": "user", "isSidechain": False,
                  "message": {"role": "user", "content": [{"type": "text", "text": "два"}, {"type": "image"}]}}
        self.assertReported(self.run_on([user("раз"), bash(ASK), results(), prompt, QUESTION]))

    def test_a_peer_message_starts_a_turn(self):
        peer = user("<cross-session-message>…</cross-session-message>", isMeta=True,
                    origin={"kind": "peer"}, turnOrigin="peer")
        self.assertReported(self.run_on([user("раз"), bash(ASK), results(), say("ok"), peer, QUESTION]))

    def test_text_injected_after_a_tool_call_does_not_start_a_turn(self):
        # A skill's body arrives as meta user text tied to the tool call that loaded it.
        skill = user([{"type": "text", "text": "skill body"}], isMeta=True, sourceToolUseID="t1")
        self.assertSilent(self.run_on([user("сделай"), bash(ASK), results(), skill, QUESTION]))

    # Nothing to check against, or nothing readable

    def test_stop_hook_active_is_silent(self):
        self.assertSilent(self.run_on([user("сделай"), QUESTION], "--stop-hook-active"))

    def test_no_queue_file_is_silent(self):
        self.assertSilent(self.run_on([user("сделай"), QUESTION], queue=Path(self.dir.name) / "absent.json"))

    def test_a_queue_with_no_tasks_is_silent(self):
        self.queue.write_text(json.dumps({"title": "t", "tasks": []}))
        self.assertSilent(self.run_on([user("сделай"), QUESTION]))

    def test_an_unparsable_queue_is_silent(self):
        self.queue.write_text("{not json")
        self.assertSilent(self.run_on([user("сделай"), QUESTION]))

    def test_a_malformed_transcript_line_is_silent(self):
        self.assertSilent(self.run_on([user("сделай"), "{broken", QUESTION]))

    def test_a_garbage_transcript_is_silent(self):
        self.assertSilent(self.run_on(["\x00\x01 not json at all ?"]))

    def test_a_missing_transcript_is_silent(self):
        r = subprocess.run([sys.executable, "-I", str(CLI), "--transcript", str(Path(self.dir.name) / "none.jsonl"),
                            "--file", str(self.queue)], capture_output=True, text=True)
        self.assertSilent(r)

    def test_under_lang_ru_the_line_is_russian(self):
        r = self.run_on([user("do it"), say("Done.\n\nMerge to main?")], "--lang", "ru")
        self.assertEqual((r.returncode, r.stdout, r.stderr), (1, LINE + "\n", ""))

    def test_a_bad_call_exits_zero_not_two(self):
        # Exit 2 from a Stop hook blocks the turn.
        r = subprocess.run([sys.executable, "-I", str(CLI), "--bogus"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
