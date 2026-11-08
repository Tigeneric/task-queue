#!/bin/bash
# Tests of stale-cache-guard.py over synthetic transcripts. Run after every change.
# The decision is checked: block = exit 2 AND non-empty stderr; pass = exit 0 AND empty stderr.
GUARD="${GUARD:-$(cd "$(dirname "$0")/../bin" && pwd)/stale-cache-guard.py}"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
export GUARD_STATE="$W/state"
unset CLAUDE_PLUGIN_OPTION_LANGUAGE   # English, the default, unless a case sets it
T0=1790000000   # the time of the transcript's last call
fails=0

call() {  # call <file> <isSidechain> <ctx>
    printf '{"type":"assistant","isSidechain":%s,"timestamp":"%s","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":%s,"cache_creation_input_tokens":0}}}\n' \
        "$2" "$(date -u -r $T0 +%Y-%m-%dT%H:%M:%S.000Z)" "$3" >> "$1"
}
compact() { echo '{"type":"system","subtype":"compact_boundary","timestamp":"2026-01-01T00:00:00Z"}' >> "$1"; }

run() {  # run <want> <name> <file> <seconds after T0> [session]
    local want=$1 name=$2 f=$3 dt=$4 sid=${5:-$2} err rc got
    err=$(printf '{"session_id":"%s","transcript_path":"%s","prompt":"PROMPT"}' "$sid" "$f" \
        | GUARD_NOW=$((T0 + dt)) python3 -I "$GUARD" 2>&1 >/dev/null); rc=$?
    if [ $rc -eq 2 ] && [ -n "$err" ]; then got=block
    elif [ $rc -eq 0 ] && [ -z "$err" ]; then got=pass
    else got="rc=$rc"; fi
    if [ "$got" = "$want" ]; then echo "ok   $name"; else echo "FAIL $name: want $want, got $got"; fails=$((fails+1)); fi
}

big="$W/big.jsonl";       call "$big" false 900000
small="$W/small.jsonl";   call "$small" false 150000
side="$W/side.jsonl";     call "$side" false 150000; call "$side" true 900000
comp="$W/comp.jsonl";     call "$comp" false 900000; compact "$comp"

run pass  idle-under-1h        "$big"   3000
run block idle-over-1h-big     "$big"   7200
run pass  idle-over-1h-small   "$small" 7200
run pass  sidechain-ignored    "$side"  7200
run pass  after-compact        "$comp"  7200
run block resend-first         "$big"   7200 grace
run pass  resend-within-grace  "$big"   7320 grace
run block resend-after-grace   "$big"   7200 late
run block resend-after-grace-2 "$big"   7900 late

# /compact in a cold session goes through at once: it is the cheap way out the block suggests.
for p in '/compact resume from the note' '  /compact'; do
    err=$(printf '{"session_id":"cmp-%s","transcript_path":"%s","prompt":"%s"}' "${#p}" "$big" "$p" | GUARD_NOW=$((T0+7200)) python3 -I "$GUARD" 2>&1 >/dev/null); rc=$?
    [ $rc -eq 0 ] && [ -z "$err" ] && echo "ok   compact-passes-cold ($p)" || { echo "FAIL compact-passes-cold ($p) rc=$rc"; fails=$((fails+1)); }
done
# …while compact anywhere but the start is an ordinary prompt and is blocked.
err=$(printf '{"session_id":"cmp2","transcript_path":"%s","prompt":"please /compact"}' "$big" | GUARD_NOW=$((T0+7200)) python3 -I "$GUARD" 2>&1 >/dev/null); rc=$?
[ $rc -eq 2 ] && echo "ok   compact-mid-prompt-blocks" || { echo "FAIL compact-mid-prompt-blocks rc=$rc"; fails=$((fails+1)); }

err=$(echo '{}' | python3 -I "$GUARD" 2>&1); rc=$?
[ $rc -eq 0 ] && [ -z "$err" ] && echo "ok   broken-input" || { echo "FAIL broken-input rc=$rc"; fails=$((fails+1)); }

# The prompt must come back to the user: Claude Code erases it on exit 2.
err=$(printf '{"session_id":"echo","transcript_path":"%s","prompt":"PROMPT"}' "$big" | GUARD_NOW=$((T0+7200)) python3 -I "$GUARD" 2>&1 >/dev/null)
case "$err" in *"PROMPT"*) echo "ok   prompt-echoed";; *) echo "FAIL prompt-echoed"; fails=$((fails+1));; esac

# --- PreToolUse SendMessage: denied when the recipient has gone cold ---
# The sender is warm; the recipient's transcript, found by socket or by name, decides.
export GUARD_SESSIONS="$W/sessions" GUARD_PROJECTS="$W/projects"
mkdir -p "$GUARD_SESSIONS" "$W/projects/-peer-cold" "$W/projects/-peer-small" "$W/projects/-peer-warm"
peer() {  # peer <pid> <name> <sid> <cwd> <ctx> <seconds before T0+7200 of last call>
    printf '{"pid":%s,"name":"%s","sessionId":"%s","cwd":"%s"}' "$1" "$2" "$3" "$4" > "$GUARD_SESSIONS/$1.json"
    local f="$W/projects/$(echo "$4" | tr '/.' '--')/$3.jsonl"
    printf '{"type":"assistant","isSidechain":false,"timestamp":"%s","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":%s,"cache_creation_input_tokens":0}}}\n' \
        "$(date -u -r $((T0 + 7200 - $6)) +%Y-%m-%dT%H:%M:%S.000Z)" "$5" > "$f"
}
peer 101 "Coldy🎻"   s-cold  /peer/cold  700000 4800
peer 102 "Smally🏚️"  s-small /peer/small 300000 4800
peer 103 "Warmy🏚️"   s-warm  /peer/warm  700000 600
sender="$W/sender.jsonl"; : > "$sender"

send() {  # send <want> <name> <to> [message] [dt]
    local want=$1 name=$2 to=$3 msg=${4-text} dt=${5:-7200} out rc got
    out=$(printf '{"session_id":"me","transcript_path":"%s","hook_event_name":"PreToolUse","tool_name":"SendMessage","tool_input":{"to":"%s","message":"%s"}}' "$sender" "$to" "$msg" \
        | GUARD_NOW=$((T0 + dt)) python3 -I "$GUARD" 2>/dev/null); rc=$?
    if [ $rc -eq 0 ] && printf '%s' "$out" | grep -q '"permissionDecision": *"deny"'; then got=deny
    elif [ $rc -eq 0 ] && [ -z "$out" ]; then got=allow
    else got="rc=$rc out=$out"; fi
    if [ "$got" = "$want" ]; then echo "ok   $name"; else echo "FAIL $name: want $want, got $got"; fails=$((fails+1)); fi
}
send deny  send-cold-by-socket   "uds:/tmp/cc-socks/101.sock"
send deny  send-resend-alone     "uds:/tmp/cc-socks/101.sock" text 7300
send deny  send-cold-by-name     "Coldy"
GUARD_NOW=$((T0 + 7200)) python3 -I "$GUARD" --allow "Coldy🎻" </dev/null >/dev/null
send allow send-after-owner-allow "Coldy" text 7300
send deny  send-allow-used-up    "Coldy" text 7310
GUARD_NOW=$((T0 + 7200)) python3 -I "$GUARD" --allow Coldy </dev/null >/dev/null
send deny  send-allow-expired    "Coldy" text 7900
rm -f "$GUARD_STATE"/allow-*
send deny  send-cold-badge-ref   "Coldy🎻 [ab12cd]"
send allow send-small-ctx        "Smally"
send allow send-warm             "uds:/tmp/cc-socks/103.sock"
send allow send-unknown-peer     "nobody"
send allow send-subscribe-only   "Coldy" ""
out=$(printf '{"session_id":"me","transcript_path":"%s","tool_name":"SendMessage","tool_input":{"to":"Warmy","message":"x"}}' "$sender" | GUARD_NOW=$((T0+11000)) python3 -I "$GUARD" 2>/dev/null)
case "$out" in *"Warmy"*"min"*) echo "ok   deny-names-peer";; *) echo "FAIL deny-names-peer: $out"; fails=$((fails+1));; esac

# --- --status: the cold sessions, for the /queue pane ---
st=$(GUARD_NOW=$((T0 + 7200)) python3 -I "$GUARD" --status </dev/null)
python3 -I -c 'import json,sys; d=json.loads(sys.argv[1]); assert d["Coldy"]["cold"] and not d["Smally"]["cold"] and not d["Warmy"]["cold"], d' "$st" \
    && echo "ok   status-cold-set" || { echo "FAIL status-cold-set: $st"; fails=$((fails+1)); }
st=$(GUARD_NOW=$((T0 + 7200)) python3 -I "$GUARD" --status Coldy </dev/null)
python3 -I -c 'import json,sys; d=json.loads(sys.argv[1]); assert list(d)==["Coldy"], d' "$st" \
    && echo "ok   status-only-named" || { echo "FAIL status-only-named: $st"; fails=$((fails+1)); }
GUARD_NOW=$((T0 + 7200)) python3 -I "$GUARD" --allow Coldy </dev/null >/dev/null
st=$(GUARD_NOW=$((T0 + 7300)) python3 -I "$GUARD" --status </dev/null)
python3 -I -c 'import json,sys; d=json.loads(sys.argv[1]); assert d["Coldy"].get("allowed") and "allowed" not in d["Warmy"], d' "$st" \
    && echo "ok   status-allowed" || { echo "FAIL status-allowed: $st"; fails=$((fails+1)); }
rm -f "$GUARD_STATE"/allow-*

# --- the transcript's tail: a compact boundary at the end, the call far from it ---
long="$W/long.jsonl"; call "$long" false 900000
head -c 4000000 /dev/zero | tr '\0' 'x' | fold -w 1000 | sed 's/.*/{"type":"user","pad":"&"}/' >> "$long"; echo >> "$long"
run block tail-falls-back-to-full "$long" 7200
compact "$long"
run pass  tail-boundary-last      "$long" 7200

# --- woken: the owner's mark, used up by the sender, lets the receiver's prompt through ---
# The receiving guard used to block the very message the owner had allowed, so the wake never landed.
GUARD_NOW=$((T0 + 7200)) python3 -I "$GUARD" --allow Coldy </dev/null >/dev/null
send allow wake-send-passes "Coldy" text 7210
coldt="$W/projects/-peer-cold/s-cold.jsonl"
err=$(printf '{"session_id":"s-cold","transcript_path":"%s","prompt":"<cross-session-message from=x>hi</cross-session-message>"}' "$coldt" \
    | GUARD_NOW=$((T0 + 7230)) python3 -I "$GUARD" 2>&1 >/dev/null); rc=$?
[ $rc -eq 0 ] && [ -z "$err" ] && echo "ok   wake-receiver-passes" || { echo "FAIL wake-receiver-passes rc=$rc"; fails=$((fails+1)); }
err=$(printf '{"session_id":"s-cold","transcript_path":"%s","prompt":"again"}' "$coldt" \
    | GUARD_NOW=$((T0 + 7240)) python3 -I "$GUARD" 2>&1 >/dev/null); rc=$?
[ $rc -eq 2 ] && echo "ok   wake-used-once" || { echo "FAIL wake-used-once rc=$rc"; fails=$((fails+1)); }
rm -f "$GUARD_STATE"/s-cold "$GUARD_STATE"/woken-*

# --- language: English by default, Russian under the plugin's language option ---
# Cyrillic by code point: grep's [А-я] compares bytes in the C locale a CI runner has, and the
# bytes of ⏸ and ≈ in the English text fall inside that range.
has_cyrillic() { python3 -I -c 'import re, sys; sys.exit(0 if re.search("[\u0400-\u04ff]", sys.stdin.buffer.read().decode("utf-8")) else 1)'; }
err=$(printf '{"session_id":"lang-en","transcript_path":"%s","prompt":"p"}' "$big" | GUARD_NOW=$((T0+7200)) python3 -I "$GUARD" 2>&1 >/dev/null)
case "$err" in "⏸ This session's cache has expired"*) printf '%s' "$err" | has_cyrillic && { echo "FAIL block-en-has-russian"; fails=$((fails+1)); } || echo "ok   block-en";; *) echo "FAIL block-en: $err"; fails=$((fails+1));; esac
err=$(printf '{"session_id":"lang-ru","transcript_path":"%s","prompt":"p"}' "$big" | CLAUDE_PLUGIN_OPTION_LANGUAGE=ru GUARD_NOW=$((T0+7200)) python3 -I "$GUARD" 2>&1 >/dev/null)
case "$err" in "⏸ Кеш этой сессии истёк"*) echo "ok   block-ru";; *) echo "FAIL block-ru: $err"; fails=$((fails+1));; esac
out=$(printf '{"session_id":"me","transcript_path":"%s","tool_name":"SendMessage","tool_input":{"to":"Warmy","message":"x"}}' "$sender" | GUARD_NOW=$((T0+11000)) python3 -I "$GUARD" 2>/dev/null)
case "$out" in *"its cache has expired"*) printf '%s' "$out" | has_cyrillic && { echo "FAIL deny-en-has-russian"; fails=$((fails+1)); } || echo "ok   deny-en";; *) echo "FAIL deny-en: $out"; fails=$((fails+1));; esac
out=$(printf '{"session_id":"me","transcript_path":"%s","tool_name":"SendMessage","tool_input":{"to":"Warmy","message":"x"}}' "$sender" | CLAUDE_PLUGIN_OPTION_LANGUAGE=ru GUARD_NOW=$((T0+11000)) python3 -I "$GUARD" 2>/dev/null)
case "$out" in *"кеш истёк"*) echo "ok   deny-ru";; *) echo "FAIL deny-ru: $out"; fails=$((fails+1));; esac

[ $fails -eq 0 ] && echo "ALL OK" || { echo "$fails FAILED"; exit 1; }
