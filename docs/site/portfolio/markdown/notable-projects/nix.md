# Nix

A programmable collaborative workspace for documents, structured data and project workflows — running in my homelab and used by family and friends.

Built around a composable item model where documents, canvases, spreadsheets and structured views share the same hierarchy. Real-time editing uses CRDT state and WebSocket synchronisation, while PostgreSQL Row-Level Security keeps authorization in the database rather than encoding a growing permission graph into JWTs. A Go worker tier consumes durable RabbitMQ jobs for imports, exports, search indexing and plugin events without direct database credentials; Postgres remains the source of truth while OpenSearch is treated as disposable, rebuildable derived state.

