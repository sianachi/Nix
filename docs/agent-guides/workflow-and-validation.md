# Workflow and validation guide

Before editing in a shared or dirty checkout, create a focused worktree with
`scripts/new-goal-worktree.sh <feature-slug> [base-ref]`. Run
`scripts/validate-changed.sh --working-tree` against the actual diff before
claiming work is verified; use `--dry-run` to inspect the exact command list.
Its recommendations are local minimums; CI path filters and review requirements
still govern merging. Root recursive commands are useful for cross-cutting
changes, not a default for a narrowly scoped edit.

Every frontend guard has a fixture self-test. Run its self-test before the guard.
The Storybook runner can hang in headless environments; stop after a couple of
minutes and report axe coverage unverified. Re-run isolated calendar tests before
calling a parallel-only timeout a regression.

One task produces one Conventional Commit when the owner asks for a commit. Never
include automation attribution, never push/commit to `main`, and stage paths
explicitly. Reviews are required before commit: UX for UI, DX for structure,
performance/memory for I/O and stores, security for sensitive boundaries, and
backend-data review for persistence/SQL. Findings are fixed or become an ADR.
