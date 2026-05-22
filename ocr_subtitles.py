import json
import sys
from pathlib import Path

from rapidocr_onnxruntime import RapidOCR

NOISE_PATTERNS = (
    "登录",
    "验证",
    "取消",
    "关闭",
    "稍后",
    "以后再说",
    "下次再说",
    "暂不",
    "我知道了",
    "抖音",
    "打开 App",
    "打开app",
)


def extract_text(ocr, image_path: Path) -> str:
    result, _ = ocr(str(image_path))
    if not result:
        return ""
    lines = []
    for item in result:
      if not item or len(item) < 2:
        continue
      text = str(item[1]).strip()
      if text and not any(pattern in text for pattern in NOISE_PATTERNS):
        lines.append(text)
    return "\n".join(lines)


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: ocr_subtitles.py <output-json> <image1> [image2...]")

    output_path = Path(sys.argv[1]).resolve()
    image_paths = [Path(arg).resolve() for arg in sys.argv[2:]]
    ocr = RapidOCR()
    all_text = []
    for image_path in image_paths:
        text = extract_text(ocr, image_path)
        if text:
            all_text.append(text)

    payload = {
        "text": "\n".join(all_text),
        "frames": len(image_paths),
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
