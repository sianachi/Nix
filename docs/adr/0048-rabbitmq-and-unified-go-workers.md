# ADR-0048: RabbitMQ and unified Go workers replace Media

## Status

Accepted, 2026-08-31.

Implementation note, 5 September 2026: unified Go/RabbitMQ source has replaced Node Media.
The temporary file-publication path currently bypasses upload inspection; the inspection
guarantee below is not current behavior. See [the discrepancy record](../README.md#open-architecture-discrepancy).
This note preserves the accepted decision and does not approve the deviation.

## Context

ADR-0046 introduced separate Go import, export and indexing services that poll durable Postgres jobs
through Nix.Api. ADR-0047 assigned object-storage capabilities, file inspection and delivery to the
Node Media service. The resulting local deployment has four worker processes plus Media, duplicates
document conversion between Go and TypeScript, and turns ordinary asynchronous work into repeated
HTTP polling. It also leaves export formats hard-coded in clients even though exporters are the only
components that can truthfully report their current capabilities.

Nix needs durable work and independent production scaling, but those needs do not require separate
source packages or local processes. PostgreSQL must remain authoritative for job state and workspace
data, Core must remain the only authorization and RLS authority, and file bytes must still bypass
Core. Collaboration remains the authoritative boundary for Yjs-backed editable bodies.

## Decision

RabbitMQ is the transport for import, export, indexing and plugin work. Nix.Api transactionally
records each job or workspace change with a durable outbox message, publishes with confirms, and
consumes worker progress, results and capability advertisements. PostgreSQL remains authoritative;
RabbitMQ messages are at-least-once notifications carrying identifiers and version metadata, never
user tokens, document bodies, file bytes or presigned URLs. Consumers use durable quorum queues,
manual acknowledgements, bounded retries, inbox deduplication and dead-letter queues.

One Go program, `nix-worker`, contains independently selectable import, export, index, plugin-event
and cleanup roles. Local development runs the roles together behind one health listener. Production
may run the same image more than once with different role sets and resource limits. Roles share
configuration, telemetry, RabbitMQ lifecycle and bounded execution infrastructure; they remain
separate domain packages. The previous polling entrypoints and lease loops are removed after the
coordinated cutover.

Nix.Api owns narrowly scoped object-storage signing credentials. It authorizes object operations and
returns short-lived upload, download or job capabilities, but never receives or proxies object
bytes. Go workers inspect staged uploads, parse imports, generate exports and clean abandoned
objects. Authorized downloads redirect to private object storage with controlled response headers.
This supersedes ADR-0047 only where it assigns those responsibilities to Media; its immutable file
versions, bounded validation, non-execution, preview limits and explicit absence of malware scanning
remain binding.

The Go export role is authoritative for lossless `.nix`, Markdown, DOCX and PDF output. It advertises
versioned format descriptors through RabbitMQ at startup and by heartbeat. Nix.Api retains the last
descriptor but marks it unavailable when its provider expires, allowing clients to display disabled
formats truthfully. Publisher-qualified plugin formats use the same registry; built-in identifiers
are reserved.

Document preview is non-mutating. Import commit references the preview digest and parser version,
then stages the complete item subtree, Collaboration bodies and file versions before one authorized
publication step. Failure, cancellation, permission loss or lease loss publishes nothing and
removes staged artifacts. Template parsing and managed-template synchronization use the same Go
archive implementation.

Plugins are immutable signed WebAssembly components executed inside the Go process, not another
service. Installation and capability grants are durable Nix.Api data. The runtime exposes no
filesystem, environment, network, clock, randomness, broker or database access; all permitted data
operations cross explicit, bounded Nix.Api host calls. Workspace events contain identifiers only and
carry causation metadata to bound feedback loops.

The Node Media service is removed only after Go import/export golden fixtures, round trips, file
security tests and failure-recovery tests pass. The production change is coordinated rather than a
long-lived dual path: drain old consumers, publish pending durable work, deploy RabbitMQ consumers,
verify recovery, then remove Media and the polling feature flags in the same release.

## Consequences

- Nix adds RabbitMQ as a stateful dependency but removes Media and multiple independently managed Go
  binaries.
- A RabbitMQ outage delays asynchronous work without losing accepted jobs or blocking ordinary
  workspace reads and writes; the Postgres outbox resumes publication after recovery.
- Core holds object-signing credentials, increasing its secret scope without increasing its request
  body or memory exposure.
- Go must reach conversion parity with the existing TypeScript archive, Markdown, DOCX and PDF
  implementations before their packages can be removed from the runtime path.
- Collaboration, PostgreSQL, object storage, OpenSearch and Zitadel retain their existing authority
  boundaries. OpenSearch remains disposable derived state.
- ADR-0046 is superseded for worker topology, polling and gradual per-format migration. Its Go
  isolation, Nix.Api authority and rebuildable-index decisions remain binding.
