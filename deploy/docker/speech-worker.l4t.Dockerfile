# syntax=docker/dockerfile:1

# The speech role's image for an NVIDIA Jetson (ADR-0059): whisper.cpp built against CUDA so
# recognition runs on the board's GPU. linux/arm64 only, and tied to the host's JetPack line: the
# base images below are JetPack 6 (L4T R36.4, CUDA 12.6), and a host on another JetPack needs
# this rebuilt against that release's images before it is upgraded. It runs with the NVIDIA
# container runtime; nothing else in the deployment does.
#
# Everything but the whisper build and the base is the same as speech-worker.Dockerfile.

ARG L4T_BUILD_IMAGE=nvcr.io/nvidia/l4t-jetpack:r36.4.0
ARG L4T_RUNTIME_IMAGE=nvcr.io/nvidia/l4t-cuda:12.6.11-runtime

FROM golang:1.26-alpine AS build
WORKDIR /src
COPY apps/go-workers/go.mod ./
COPY apps/go-workers ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/nix-worker ./cmd/nix-worker

FROM ${L4T_BUILD_IMAGE} AS whisper
ARG WHISPER_CPP_VERSION=v1.7.6
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git cmake build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${WHISPER_CPP_VERSION}" https://github.com/ggml-org/whisper.cpp.git /src \
    && PATH="/usr/local/cuda/bin:${PATH}" cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_CUDA=1 -DWHISPER_BUILD_TESTS=OFF \
    && cmake --build /src/build --config Release --target whisper-server -j "$(nproc)" \
    && install -D /src/build/bin/whisper-server /out/whisper-server

FROM debian:bookworm-slim AS piper
ARG PIPER_VERSION=2023.11.14-2
ARG PIPER_SHA256_ARM64=fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN test "$(uname -m)" = aarch64 \
    && curl --fail --silent --show-error --location --output /tmp/piper.tar.gz \
      "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_aarch64.tar.gz" \
    && echo "${PIPER_SHA256_ARM64}  /tmp/piper.tar.gz" | sha256sum --check --strict \
    && mkdir -p /out \
    && tar --extract --gzip --file /tmp/piper.tar.gz --directory /out \
    && test -x /out/piper/piper

FROM ${L4T_RUNTIME_IMAGE}
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
