# personal-assistant — the local voice stack ("Jarvis"), Windows.
#
# Idempotent: run it again to repair or update. What it sets up:
#
#   %LOCALAPPDATA%\personal-assistant\voice-venv     Python 3.12 (uv) with torch CUDA,
#                                                     Kokoro-82M, onnxruntime, transformers
#   %LOCALAPPDATA%\personal-assistant\voice-models   the browser's models: Silero VAD,
#                                                     openWakeWord ("hey jarvis") and
#                                                     onnxruntime-web, plus smart-turn v3.2
#   scheduled task  pa-voice                          voice/server.py on 127.0.0.1:47830
#
# The voice service speaks (Kokoro on the GPU) and judges end of turn
# (smart-turn); the PA dashboard proxies it at /api/talk/tts and
# /api/talk/endpoint. README: "Talking to it by voice".
#
# Needs: uv (https://docs.astral.sh/uv/), an NVIDIA GPU with a CUDA 12.8 driver,
# npm (for the onnxruntime-web files). Nothing here touches .env.

[CmdletBinding()]
param(
  [switch]$NoTask,      # do not register the scheduled task
  [switch]$NoStart,     # register it but do not start it now
  [string]$TorchIndex = 'https://download.pytorch.org/whl/cu128',
  [string]$OrtWebVersion = '1.22.0'
)

# 'Continue', not 'Stop': uv and npm write progress to stderr, which Windows
# PowerShell turns into errors under 'Stop' when output is redirected. Every
# native step checks $LASTEXITCODE; every cmdlet that matters says -ErrorAction Stop.
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$dataDir = Join-Path $env:LOCALAPPDATA 'personal-assistant'
$venv = Join-Path $dataDir 'voice-venv'
$py = Join-Path $venv 'Scripts\python.exe'
$models = Join-Path $dataDir 'voice-models'

# Same reason as install.ps1: a console program in an Interactive logon task
# gets a visible window that kills the task when closed.
function New-HeadlessAction([string]$Exe, [string]$Arguments, [string]$WorkingDirectory) {
  $params = @{ Execute = "$env:SystemRoot\System32\conhost.exe"; Argument = "--headless `"$Exe`" $Arguments" }
  if ($WorkingDirectory) { $params.WorkingDirectory = $WorkingDirectory }
  New-ScheduledTaskAction @params
}

function Get-File([string]$Url, [string]$Dest) {
  if ((Test-Path $Dest) -and (Get-Item $Dest).Length -gt 0) { return }
  Write-Host "    downloading $(Split-Path -Leaf $Dest)"
  $tmp = "$Dest.part"
  Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing -ErrorAction Stop
  Move-Item -Force $tmp $Dest -ErrorAction Stop
}

Write-Host "personal-assistant voice install" -ForegroundColor Cyan
$uv = (Get-Command uv -ErrorAction SilentlyContinue)
if (-not $uv) { throw 'uv is not on PATH: install it from https://docs.astral.sh/uv/ and run this again' }
New-Item -ItemType Directory -Force $dataDir, $models | Out-Null

# --- the venv -----------------------------------------------------------------

if (-not (Test-Path $py)) {
  Write-Host "==> creating $venv (Python 3.12)"
  uv venv -p 3.12 $venv
  if ($LASTEXITCODE -ne 0) { throw 'uv venv failed' }
}
Write-Host "==> torch (CUDA 12.8)"
uv pip install -p $py torch --index-url $TorchIndex
if ($LASTEXITCODE -ne 0) { throw 'installing torch failed' }
Write-Host "==> Kokoro, onnxruntime, smart-turn features"
uv pip install -p $py 'kokoro>=0.9.4' 'misaki[en]' soundfile numpy onnxruntime transformers
if ($LASTEXITCODE -ne 0) { throw 'installing the voice packages failed' }
# misaki's English G2P needs spaCy's small model, and it is not on PyPI: without
# it the first sentence fails with "No virtual environment found".
uv pip install -p $py 'en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl'
if ($LASTEXITCODE -ne 0) { throw 'installing en_core_web_sm failed' }

# --- models -------------------------------------------------------------------

Write-Host "==> models in $models"
Get-File 'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx' (Join-Path $models 'smart-turn-v3.2-cpu.onnx')
Get-File 'https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx' (Join-Path $models 'silero_vad.onnx')
foreach ($m in @('melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx')) {
  Get-File "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/$m" (Join-Path $models $m)
}

# onnxruntime-web runs Silero and the wake word in the page. Its files are
# served by the PA (/talk/models/ort/...), so the page needs no CDN.
$ort = Join-Path $models 'ort'
$ortWasm = Join-Path $ort 'ort-wasm-simd-threaded.wasm'
$ortStamp = Join-Path $ort "version-$OrtWebVersion"
if (-not (Test-Path $ortStamp)) {
  Write-Host "==> onnxruntime-web $OrtWebVersion"
  $tmp = Join-Path $env:TEMP "pa-ortweb-$PID"
  New-Item -ItemType Directory -Force $tmp | Out-Null
  Push-Location $tmp
  try {
    npm pack "onnxruntime-web@$OrtWebVersion" --silent | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'npm pack onnxruntime-web failed' }
    tar -xzf "onnxruntime-web-$OrtWebVersion.tgz"
    if ($LASTEXITCODE -ne 0) { throw 'unpacking onnxruntime-web failed' }
    if (Test-Path $ort) { Remove-Item -Recurse -Force $ort }
    New-Item -ItemType Directory -Force $ort | Out-Null
    foreach ($f in @('ort.wasm.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm')) {
      Copy-Item (Join-Path 'package\dist' $f) (Join-Path $ort $f) -ErrorAction Stop
    }
    New-Item -ItemType File $ortStamp | Out-Null
  } finally {
    Pop-Location
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

# --- self-test ------------------------------------------------------------------

Write-Host "==> self-test (loads Kokoro on the GPU: ~30 s the first time)"
& $py -I (Join-Path $root 'voice\selftest.py') --models $models
if ($LASTEXITCODE -ne 0) { throw 'the voice self-test failed (see above)' }

# --- the service ------------------------------------------------------------------

if (-not $NoTask) {
  Write-Host "==> registering the pa-voice task"
  $action = New-HeadlessAction -Exe $py -Arguments "-I voice\server.py --models `"$models`"" -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName 'pa-voice' -Action $action -Trigger $trigger -Settings $settings `
    -Description 'personal-assistant local voice: Kokoro TTS and smart-turn on 127.0.0.1:47830' -Force -ErrorAction Stop | Out-Null
  if (-not $NoStart) {
    Start-ScheduledTask -TaskName 'pa-voice'
    Write-Host "    started; GET http://127.0.0.1:47830/health answers once Kokoro is warm (~30 s)"
  } else {
    Write-Host "    registered (not started): Start-ScheduledTask pa-voice"
  }
}

Write-Host ""
Write-Host "Done. Open http://127.0.0.1:7300/talk and check 'node bin\pa.js doctor'." -ForegroundColor Cyan
