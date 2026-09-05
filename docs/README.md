# Documentation

Reviewed against the repository on 5 September 2026. Implementation statements are source-backed;
this documentation refresh did not rerun application, device, security or disaster-recovery tests.

- [Product, features and quick start](../README.md)
- [Local setup and sign-in](dev-signing-in.md)
- [Operations and recovery](operations.md)
- [Contributor routing](../AGENTS.md) and [validation](agent-guides/workflow-and-validation.md)
- [Personal workspaces and identity](adr/0045-personal-workspaces-and-opt-in-jit.md)
- [Current worker architecture](adr/0048-rabbitmq-and-unified-go-workers.md)
- [Earlier worker decision](adr/0046-go-workers-and-opensearch.md), superseded for topology
- [File and import decision](adr/0047-lightweight-file-bodies-and-document-import.md), with implementation discrepancy noted
- [Mobile view work and recorded validation](plans/mobile-view-quality.md)

`HANDOFF.md`, `todo.md`, `worklist.md` and old session logs are historical records. Their old
checkboxes, test counts and continuation instructions are not current task state. The imported
design-review documents are historical references, not current architecture or setup instructions.
Use README, accepted ADRs, current code and the actual worktree together.

## Open architecture discrepancy

The temporary opaque upload publication path in `FileEndpoints.cs` and `FileStore.cs` bypasses
inspection. ADR-0047 and ADR-0048 describe inspected uploads, so those guarantees must not be
inferred from the accepted design. This needs an owner-reviewed follow-up decision or restoration
of the designed path; this documentation refresh does not approve the deviation. Recent previews
also go beyond ADR-0047's original inline-image-only wording. Files are not malware-scanned. The Kubernetes deployment script also still applies the legacy
Media image manifest; see [operations](operations.md) before relying on the cutover templates.

## Release scope

Mobile dialogs, navigation, view adaptations, draft/PWA changes and the R2 backup helper are
included in this release. Deployment and runtime verification remain separate from source availability.
Existing validation records retain their original scope; they are not new verification results.
