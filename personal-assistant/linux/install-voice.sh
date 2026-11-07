#!/usr/bin/env bash
# personal-assistant — the local voice stack ("Jarvis"), Linux. The counterpart
# of windows/install-voice.ps1.
#
#   linux/install-voice.sh [--cuda] [--no-unit] [--no-start]
#
# Idempotent: run it again to repair or update. What it sets up, under the
# worker's data dir (~/.local/share/personal-assistant by default):
#
#   voice-venv     Python 3.12 (uv) with torch, Kokoro-82M, onnxruntime,
#                  transformers. torch is the CPU build unless --cuda (CUDA 12.8):
#                  Kokoro on a modern CPU speaks a sentence in well under a
#                  second, and the CPU wheel is a fifth of the size.
#   voice-models   the browser's models: Silero VAD, openWakeWord ("hey jarvis")
#                  and onnxruntime-web, plus smart-turn v3.2
#   pa-voice       a systemd *user* unit: voice/server.py on 127.0.0.1:47830
#
# Needs: uv (https://docs.astral.sh/uv/), curl, npm. Nothing here touches .env.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

TORCH_INDEX='https://download.pytorch.org/whl/cpu'
DEVICE=cpu
UNIT=1
START=1
ORT_WEB_VERSION='1.22.0'
for arg in "$@"; do
  case "$arg" in
    --cuda) TORCH_INDEX='https://download.pytorch.org/whl/cu128'; DEVICE=cuda ;;
    --no-unit) UNIT=0 ;;
    --no-start) START=0 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

say() { printf '==> %s\n' "$*"; }

command -v node >/dev/null 2>&1 || { echo "node not found" >&2; exit 1; }
UV="$(command -v uv || true)"
[ -n "$UV" ] || [ ! -x "$HOME/.local/bin/uv" ] || UV="$HOME/.local/bin/uv"
[ -n "$UV" ] || { echo "uv not found: install it from https://docs.astral.sh/uv/ and run this again" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl not found" >&2; exit 1; }

# The paths the worker and the unit use — the same resolution, .env included.
VENV_PY="$(cd "$ROOT" && node -p 'require("./src/config").config.voice.python')"
MODELS="$(cd "$ROOT" && node -p 'require("./src/config").config.voice.models')"
VENV="$(dirname "$(dirname "$VENV_PY")")"
mkdir -p "$MODELS"

echo "personal-assistant voice install (Linux, $DEVICE)"

# --- the venv -----------------------------------------------------------------

if [ ! -x "$VENV_PY" ]; then
  say "creating $VENV (Python 3.12)"
  "$UV" venv -p 3.12 "$VENV"
fi
say "torch ($DEVICE)"
"$UV" pip install -p "$VENV_PY" torch --index-url "$TORCH_INDEX"
say "Kokoro, onnxruntime, smart-turn features"
"$UV" pip install -p "$VENV_PY" 'kokoro>=0.9.4' 'misaki[en]' soundfile numpy onnxruntime transformers
# misaki's English G2P needs spaCy's small model, which is not on PyPI.
"$UV" pip install -p "$VENV_PY" 'en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl'

# --- models -------------------------------------------------------------------

get() {  # get <url> <dest>: skip when present
  local url="$1" dest="$2"
  [ -s "$dest" ] && return 0
  echo "    downloading $(basename "$dest")"
  curl -fsSL --retry 3 -o "$dest.part" "$url"
  mv -f "$dest.part" "$dest"
}

say "models in $MODELS"
get 'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx' "$MODELS/smart-turn-v3.2-cpu.onnx"
get 'https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx' "$MODELS/silero_vad.onnx"
for m in melspectrogram.onnx embedding_model.onnx hey_jarvis_v0.1.onnx; do
  get "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/$m" "$MODELS/$m"
done

# onnxruntime-web runs Silero and the wake word in the page; the PA serves its
# files (/talk/models/ort/...), so the page needs no CDN.
ORT="$MODELS/ort"
if [ ! -f "$ORT/version-$ORT_WEB_VERSION" ]; then
  say "onnxruntime-web $ORT_WEB_VERSION"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  ( cd "$TMP" && npm pack "onnxruntime-web@$ORT_WEB_VERSION" --silent >/dev/null && tar -xzf "onnxruntime-web-$ORT_WEB_VERSION.tgz" )
  rm -rf "$ORT"
  mkdir -p "$ORT"
  for f in ort.wasm.min.js ort-wasm-simd-threaded.mjs ort-wasm-simd-threaded.wasm; do
    cp "$TMP/package/dist/$f" "$ORT/$f"
  done
  touch "$ORT/version-$ORT_WEB_VERSION"
fi

# --- self-test ------------------------------------------------------------------

say "self-test (loads Kokoro on the $DEVICE: ~30 s the first time)"
"$VENV_PY" -I "$ROOT/voice/selftest.py" --models "$MODELS" --device "$DEVICE"

# --- the service ------------------------------------------------------------------

if [ "$UNIT" = 1 ]; then
  say "writing the pa-voice user unit"
  ( cd "$ROOT" && node "$HERE/units.js" --voice )
  systemctl --user daemon-reload
  systemctl --user enable pa-voice.service >/dev/null
  if [ "$START" = 1 ]; then
    systemctl --user restart pa-voice.service
    echo "    started; curl http://127.0.0.1:47830/health answers ok once Kokoro is warm (~30 s)"
  else
    echo "    enabled (not started): systemctl --user start pa-voice"
  fi
fi

echo
echo "Done. Open the dashboard's /talk and check 'node bin/pa.js doctor'."
