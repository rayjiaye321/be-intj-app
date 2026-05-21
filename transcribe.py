import json
import os
import sys
from pathlib import Path

from faster_whisper import WhisperModel


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: transcribe.py <audio-path> <output-json> [model]")

    audio_path = Path(sys.argv[1]).resolve()
    output_path = Path(sys.argv[2]).resolve()
    model_name = sys.argv[3] if len(sys.argv) >= 4 else "base"

    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        str(audio_path),
        language="zh",
        vad_filter=True,
        beam_size=5,
        word_timestamps=False,
    )

    items = []
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue
        items.append(
            {
                "start": round(float(segment.start), 3),
                "end": round(float(segment.end), 3),
                "text": text,
            }
        )

    payload = {
        "language": getattr(info, "language", "zh"),
        "duration": float(getattr(info, "duration", 0) or 0),
        "text": "\n".join(item["text"] for item in items),
        "segments": items,
        "model": model_name,
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
