import json
import sys
import time
from pathlib import Path

from faster_whisper import WhisperModel


def fmt_ts(seconds: float, vtt: bool = False) -> str:
    ms = int(round(max(0.0, seconds) * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    sep = "." if vtt else ","
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def load_model(
    model_name: str = "large-v3",
    device: str = "cuda",
    compute_type: str | None = None,
) -> WhisperModel:
    """Load a WhisperModel. Hoisted out of transcribe_file so a batch can load once."""
    if compute_type is None:
        compute_type = "float16" if device == "cuda" else "int8"
    print(
        f"[1/3] Loading model {model_name!r} on {device} ({compute_type})...",
        file=sys.stderr,
        flush=True,
    )
    t0 = time.time()
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    print(f"      ready in {time.time()-t0:.1f}s", file=sys.stderr, flush=True)
    return model


def transcribe_file(
    audio_path: Path,
    *,
    model_name: str = "large-v3",
    language: str = "en",
    device: str = "cuda",
    compute_type: str | None = None,
    beam_size: int = 5,
    out_dir: Path | None = None,
    force: bool = False,
    model: WhisperModel | None = None,
) -> dict[str, Path]:
    audio_path = audio_path.expanduser().resolve()
    if not audio_path.exists():
        sys.exit(f"error: file not found: {audio_path}")

    out_dir = (out_dir or audio_path.parent).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = out_dir / audio_path.stem

    json_path = stem.with_suffix(".json")
    if json_path.exists() and not force:
        print(f"transcribe: {json_path} exists (use --force to redo)", file=sys.stderr)
        return {"json": json_path}

    if model is None:
        model = load_model(model_name, device, compute_type)

    print(f"[2/3] Transcribing {audio_path.name} ...", file=sys.stderr, flush=True)
    t0 = time.time()
    lang = None if language == "auto" else language
    segments, info = model.transcribe(
        str(audio_path),
        language=lang,
        beam_size=beam_size,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
    )
    print(
        f"      lang={info.language} (p={info.language_probability:.2f})  "
        f"duration={info.duration:.1f}s ({info.duration/60:.1f} min)",
        file=sys.stderr,
        flush=True,
    )

    srt_path = stem.with_suffix(".srt")
    vtt_path = stem.with_suffix(".vtt")
    txt_path = stem.with_suffix(".txt")

    seg_records = []
    last_print = 0.0
    with open(srt_path, "w", encoding="utf-8") as fsrt, open(
        vtt_path, "w", encoding="utf-8"
    ) as fvtt, open(txt_path, "w", encoding="utf-8") as ftxt:
        fvtt.write("WEBVTT\n\n")
        for i, seg in enumerate(segments, 1):
            start, end, text = seg.start, seg.end, seg.text.strip()
            fsrt.write(f"{i}\n{fmt_ts(start)} --> {fmt_ts(end)}\n{text}\n\n")
            fvtt.write(f"{fmt_ts(start, True)} --> {fmt_ts(end, True)}\n{text}\n\n")
            ftxt.write(text + "\n")
            seg_records.append({"id": i, "start": start, "end": end, "text": text})

            now = time.time()
            if now - last_print > 2.0:
                pct = 100 * end / info.duration if info.duration else 0
                rate = end / max(0.001, now - t0)
                eta = (info.duration - end) / rate if rate > 0 else 0
                print(
                    f"\r      {fmt_ts(end)} / {fmt_ts(info.duration)}  "
                    f"{pct:5.1f}%  rt={rate:4.1f}x  eta={eta:5.0f}s   ",
                    file=sys.stderr,
                    end="",
                    flush=True,
                )
                last_print = now
    print(file=sys.stderr)

    json_path.write_text(
        json.dumps(
            {
                "audio": str(audio_path),
                "model": model_name,
                "language": info.language,
                "language_probability": info.language_probability,
                "duration": info.duration,
                "segments": seg_records,
            },
            indent=2,
        )
    )

    elapsed = time.time() - t0
    print(
        f"[3/3] Done in {elapsed:.0f}s ({info.duration/elapsed:.1f}x realtime). Wrote:",
        file=sys.stderr,
    )
    out = {"json": json_path, "srt": srt_path, "vtt": vtt_path, "txt": txt_path}
    for p in out.values():
        print(f"        {p}", file=sys.stderr)
    return out


def collect_audio_files(paths: list[str], shortest_first: bool = False) -> list[Path]:
    AUDIO_EXT = {".mp3", ".m4a", ".wav", ".mp4", ".flac", ".ogg"}
    files: list[Path] = []
    for p in paths:
        pp = Path(p)
        if pp.is_dir():
            for f in sorted(pp.iterdir()):
                if f.suffix.lower() in AUDIO_EXT:
                    files.append(f)
        elif pp.is_file():
            files.append(pp)
        else:
            print(f"summarize-recording: skipping (not a file or dir): {pp}", file=sys.stderr)
    if shortest_first:
        # Byte size stands in for duration: same codec throughout a recorder's output,
        # and it avoids shelling out to ffprobe for every file just to pick an order.
        files.sort(key=lambda f: f.stat().st_size)
    return files
