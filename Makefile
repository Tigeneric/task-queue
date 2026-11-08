# Everything here is a shell away already; the targets are names for it.

.PHONY: test check

# The CLIs and the guard over synthetic transcripts: Python and bash only.
test:
	@set -e; for t in plugins/task-queue/tests/test_*.py; do echo "== $$t"; python3 -I "$$t"; done
	bash plugins/stale-cache-guard/tests/test-stale-cache-guard.sh

# Also what needs the claude CLI: the pane's tests and the manifests.
check: test
	claude plugin test plugins/task-queue
	claude plugin validate .
	claude plugin validate plugins/task-queue
	claude plugin validate plugins/stale-cache-guard
