# syntax=docker/dockerfile:1

FROM golang:1.26-alpine AS build
WORKDIR /src
ARG WORKER_CMD=./cmd/nix-worker
COPY apps/go-workers/go.mod ./
COPY apps/go-workers ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/nix-worker "$WORKER_CMD"

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/nix-worker /nix-worker
USER nonroot:nonroot
ENTRYPOINT ["/nix-worker"]
