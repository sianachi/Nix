# Go worker guide

Read for `apps/go-workers/` changes.

Keep `cmd/*/main.go` wiring-only. Workers use `internal/workerapi`, never database
credentials or backend implementation concepts. They transfer bytes only through
short-lived capability URLs, validate URL/origin/size/redirect policy, clean temp
files, and do not invent tenant context or permissions.

Use streaming with bounded archive/XML/JSON inputs. Job handling is lease-based,
cancel-aware and idempotent: crashes must recover without duplicate durable
mutations. Index writes are idempotent derived upserts/deletes and remain fully
rebuildable. `/healthz` is liveness; `/readyz` proves each role's dependencies.

Run `gofmt`, `go vet ./...`, `go test ./...`, `go test -race ./...`, and build the
unified executable for worker changes.
