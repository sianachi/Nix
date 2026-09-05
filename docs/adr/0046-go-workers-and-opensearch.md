# ADR-0046: Go workers and OpenSearch

## Status

Superseded for worker topology, polling and migration by [ADR-0048](0048-rabbitmq-and-unified-go-workers.md).
The original decision below is retained as history; database ownership and rebuildable search
constraints remain applicable.

## Decision

Nix introduces three separately deployable Go services: import, export, and indexing. They use
authenticated internal HTTP APIs and never receive Postgres credentials. Nix.Api remains the owner
of durable mutations, RLS context, and final authorization decisions.

Worker jobs and rebuildable outbox events are stored in tenant-scoped Postgres tables owned by the
backend. Job creation and an optional outbox publication are one transaction. Workers lease through
the internal API with bounded retries and explicit completion or failure.

OpenSearch is the dedicated derived search index. It is populated from outbox events and can be
rebuilt from durable Nix data. Queries carry tenant and authorization filters, while Nix.Api remains
the final authority for permissions and result visibility during migration and after cutover.

Existing Node and PostgreSQL paths remain available behind feature flags until round-trip,
determinism, authorization, and failure-recovery evidence demonstrates parity.

## Consequences

The deployment has more independently scaled services and a new stateful dependency. Operational
cost is accepted in exchange for bounded worker memory, isolated failure domains, rebuildable
derived search, and gradual migration. The CLI is not part of this decision or its implementation.
