#!/usr/bin/env bash
# Measure whisper.cpp on the production host before a model is chosen (ADR-0059).
#
# Builds whisper.cpp natively in a scratch directory, with CUDA and without, and times each
# candidate model on one clip. It touches nothing in the Nix deployment: no container, no
# volume, no service. It does load the GPU and three cores while it runs, so pick a quiet
# moment.
#
# Usage, on the host:
#   scripts/stress/whisper-host-benchmark.sh [clip]
#
# `clip` is any audio file ffmpeg can read; a real ten-minute, two-speaker recording gives a
# read of accuracy as well as speed. Without one the script loops whisper.cpp's eleven-second
# sample to ten minutes, which measures speed only.
#
# Needs: git, cmake, a C++ compiler, ffmpeg, curl, and for the GPU runs the CUDA toolkit that
# JetPack installs under /usr/local/cuda. Remove ~/nix-whisper-bench when done (about 4 GB).
set -euo pipefail

WHISPER_TAG="${WHISPER_TAG:-v1.7.6}"
WORK="${WORK:-$HOME/nix-whisper-bench}"
THREADS="${THREADS:-3}"
GPU_MODELS="${GPU_MODELS:-large-v3-turbo medium.en}"
CPU_MODELS="${CPU_MODELS:-small.en}"
CLIP="${1:-}"

for tool in git cmake c++ ffmpeg curl; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done

cuda=1
if [ ! -x /usr/local/cuda/bin/nvcc ]; then
  echo "No CUDA toolkit at /usr/local/cuda; running the CPU measurements only." >&2
  cuda=0
fi

free_kb="$(df -Pk "$HOME" | awk 'NR==2 {print $4}')"
if [ "$free_kb" -lt $((6 * 1024 * 1024)) ]; then
  echo "Less than 6 GB free under $HOME; refusing to start." >&2
  exit 1
fi

mkdir -p "$WORK"
cd "$WORK"
if [ ! -d whisper.cpp ]; then
  git clone --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp.git
fi

build() { # directory, extra cmake flags
  local dir="$1"
  shift
  if [ ! -x "whisper.cpp/$dir/bin/whisper-cli" ]; then
    PATH="/usr/local/cuda/bin:$PATH" cmake -S whisper.cpp -B "whisper.cpp/$dir" -DCMAKE_BUILD_TYPE=Release "$@" >/dev/null
    cmake --build "whisper.cpp/$dir" --config Release -j "$(nproc)" >/dev/null
  fi
}

build build-cpu
if [ "$cuda" -eq 1 ]; then
  build build-cuda -DGGML_CUDA=1
fi

for model in $CPU_MODELS $([ "$cuda" -eq 1 ] && echo "$GPU_MODELS"); do
  [ -s "whisper.cpp/models/ggml-$model.bin" ] || bash whisper.cpp/models/download-ggml-model.sh "$model" >/dev/null
done

if [ -z "$CLIP" ]; then
  echo "No clip given: looping the bundled sample to ten minutes (speed only)."
  ffmpeg -loglevel error -y -stream_loop -1 -i whisper.cpp/samples/jfk.wav -t 600 -ar 16000 -ac 1 clip.wav
else
  ffmpeg -loglevel error -y -i "$CLIP" -ar 16000 -ac 1 clip.wav
fi
seconds="$(ffprobe -v error -show_entries format=duration -of csv=p=0 clip.wav | cut -d. -f1)"

# Lowest MemAvailable seen during a run, since GPU memory on a Jetson is system memory and
# does not show in the process's resident size.
watch_memory() {
  local low
  low="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"
  while kill -0 "$1" 2>/dev/null; do
    local now
    now="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"
    [ "$now" -lt "$low" ] && low="$now"
    sleep 1
  done
  echo "$low"
}

run() { # label, build directory, model, extra whisper flags
  local label="$1" dir="$2" model="$3"
  shift 3
  local before start pid low wall
  before="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"
  start="$(date +%s)"
  nice -n 10 "whisper.cpp/$dir/bin/whisper-cli" -m "whisper.cpp/models/ggml-$model.bin" \
    -f clip.wav -t "$THREADS" -l en -otxt -of "out-$label" "$@" >"log-$label.txt" 2>&1 &
  pid=$!
  low="$(watch_memory "$pid")"
  if ! wait "$pid"; then
    echo "$label: FAILED, see $WORK/log-$label.txt"
    return
  fi
  wall=$(($(date +%s) - start))
  [ "$wall" -gt 0 ] || wall=1
  printf '%-28s %5ss wall  %5.1fx realtime  %5s MB taken\n' \
    "$label" "$wall" "$(awk -v s="$seconds" -v w="$wall" 'BEGIN {print s / w}')" "$(((before - low) / 1024))"
}

echo
echo "Clip: ${seconds}s, threads: $THREADS, whisper.cpp $WHISPER_TAG"
echo "Power mode: $(nvpmodel -q 2>/dev/null | head -1 || echo unknown)"
for model in $CPU_MODELS; do
  run "cpu-$model" build-cpu "$model" -ng
done
if [ "$cuda" -eq 1 ]; then
  for model in $GPU_MODELS; do
    run "gpu-$model" build-cuda "$model"
  done
fi
echo
echo "Transcripts: $WORK/out-*.txt   Logs: $WORK/log-*.txt"
