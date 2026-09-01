# syntax=docker/dockerfile:1

FROM golang:1.26-alpine AS build
WORKDIR /src
COPY apps/go-workers/go.mod ./
COPY apps/go-workers ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/nix-worker ./cmd/nix-worker

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates poppler-utils util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 65532 nonroot \
    && useradd --system --uid 65532 --gid nonroot --no-create-home nonroot \
    && install -d -o nonroot -g nonroot -m 0700 /var/lib/nix-worker/spool
COPY --from=build --chown=nonroot:nonroot /out/nix-worker /nix-worker
ENV TMPDIR=/var/lib/nix-worker/spool
STOPSIGNAL SIGTERM
USER 65532:65532
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=12 CMD ["/nix-worker", "--healthcheck"]
ENTRYPOINT ["/nix-worker"]
