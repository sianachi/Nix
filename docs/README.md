# Documentation

Reviewed against `main` on 8 October 2026. Implementation statements are source-backed; this
documentation refresh did not rerun application, device, security or disaster-recovery tests.

- [Product, features and quick start](../README.md)
- [Product direction: Nix as a life-OS](plans/life-os-direction.md)
- [Local setup and sign-in](dev-signing-in.md)
- [Operations and recovery](operations.md) and the [production release runbook](../deploy/README.md)
- [Contributor routing](../AGENTS.md) and [validation](agent-guides/workflow-and-validation.md)
- [Personal workspaces and identity](adr/0045-personal-workspaces-and-opt-in-jit.md)
- [Current worker architecture](adr/0048-rabbitmq-and-unified-go-workers.md)
- [Earlier worker decision](adr/0046-go-workers-and-opensearch.md), superseded for topology
- [File and import decision](adr/0047-lightweight-file-bodies-and-document-import.md)
- Later decisions, 0049 to 0059, under `adr/`: GitHub-triggered deploys (proposed, not
  implemented), companion structure tools, scheduler and automations, two-way calendar sync, the
  installed app shell, container view arrangement, locks, model-free suggestions, item
  protections and the speech role. Each ADR's Status section states what is built and which
  approvals are still owed; several are implemented ahead of their recorded acceptance.
- [Mobile view work and recorded validation](plans/mobile-view-quality.md)

`HANDOFF.md`, `todo.md`, `worklist.md` and old session logs are historical records. Their old
checkboxes, test counts and continuation instructions are not current task state. The imported
design-review documents are historical references, not current architecture or setup instructions.
Use README, accepted ADRs, current code and the actual worktree together.

Most Markdown under `docs/` is ignored by git (`.gitignore` lists `*.md` and `docs`); only the
files force-added by the owner are tracked. Check `git ls-files docs` before assuming a document
is published.

## Known deviations from accepted design

- Uploads are inspected before publication by the Go worker's `fileinspect` handler (import role):
  byte cap, expiry and size checks, SHA-256, media type from magic bytes, declared-type
  consistency, previews and thumbnails. Code comments still call this the "temporary opaque
  publish path", an upload stays in `pending_upload` with no separate inspecting state, and files
  are not malware-scanned. Whether this satisfies ADR-0047 and ADR-0048 is an owner decision that
  has not been recorded.
- ADR-0053, ADR-0058 and ADR-0059 are implemented on `main` while their status lines still read
  Proposed; their [SEC] approvals are not recorded.
- ADR-0051 is partial: the `create_from_template` action is refused by Core, `property_changed`
  fires on update only, and quiet hours and muting do not apply to automations.
- ADR-0052 is partial: recurring Nix items are not pushed as series and providers are polled
  rather than subscribed.
- ADR-0054 is partial: grouping is single-select only.

## Release scope

Deployment and runtime verification remain separate from source availability. Existing validation
records retain their original scope; they are not new verification results.
