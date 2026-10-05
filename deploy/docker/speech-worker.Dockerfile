# syntax=docker/dockerfile:1

# The speech role's image (ADR-0059): the same nix-worker binary as every other role, with the
# three programs only this role runs - whisper.cpp's server, Piper and ffmpeg. This is the
# processor-only build, for development, for hosts without a GPU and as the fallback on one that
# has it; speech-worker.l4t.Dockerfile is the Jetson build. Models and voices are never part of
# either image: they are mounted from a volume filled by deploy/compose/speech-models.sh.

FROM golang:1.26-alpine AS build
WORKDIR /src
COPY apps/go-workers/go.mod ./
COPY apps/go-workers ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/nix-worker ./cmd/nix-worker

FROM debian:bookworm-slim AS whisper
ARG WHISPER_CPP_VERSION=v1.7.6
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git cmake build-essential \
    && rm -rf /var/lib/apt/lists/*
# GGML_NATIVE is off so the binary runs on any processor of this architecture, not only on ones
# with the build machine's instruction set.
RUN git clone --depth 1 --branch "${WHISPER_CPP_VERSION}" https://github.com/ggml-org/whisper.cpp.git /src \
    && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF \
    && cmake --build /src/build --config Release --target whisper-server -j "$(nproc)" \
    && install -D /src/build/bin/whisper-server /out/whisper-server

FROM debian:bookworm-slim AS piper
ARG PIPER_VERSION=2023.11.14-2
ARG PIPER_SHA256_AMD64=a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992
ARG PIPER_SHA256_ARM64=fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN arch="$(uname -m)" && case "$arch" in \
      x86_64) package_arch=x86_64; sum="${PIPER_SHA256_AMD64}" ;; \
      aarch64) package_arch=aarch64; sum="${PIPER_SHA256_ARM64}" ;; \
      *) exit 1 ;; esac \
    && curl --fail --silent --show-error --location --output /tmp/piper.tar.gz \
      "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_${package_arch}.tar.gz" \
    && echo "${sum}  /tmp/piper.tar.gz" | sha256sum --check --strict \
    && mkdir -p /out \
    && tar --extract --gzip --file /tmp/piper.tar.gz --directory /out \
    && test -x /out/piper/piper

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates ffmpeg libgomp1 util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 65532 nonroot \
    && useradd --system --uid 65532 --gid nonroot --no-create-home nonroot \
    && install -d -o nonroot -g nonroot -m 0700 /var/lib/nix-worker/spool \
    && install -d -m 0755 /var/lib/nix-speech/models
COPY --from=piper /out/piper /opt/piper
COPY --from=whisper /out/whisper-server /usr/local/bin/whisper-server
COPY --from=build --chown=nonroot:nonroot /out/nix-worker /nix-worker
RUN ln -s /opt/piper/piper /usr/local/bin/piper
ENV TMPDIR=/var/lib/nix-worker/spool
STOPSIGNAL SIGTERM
USER 65532:65532
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=12 CMD ["/nix-worker", "--healthcheck"]
ENTRYPOINT ["/nix-worker"]
