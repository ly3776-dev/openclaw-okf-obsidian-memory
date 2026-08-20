#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path

from markitdown import MarkItDown


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    args = parser.parse_args()

    source = Path(args.input)
    md = MarkItDown()
    result = md.convert(str(source))
    output = {
        "text": getattr(result, "text_content", "") or "",
        "title": infer_title(result, source),
        "source_type": infer_source_type(source),
        "warnings": []
    }
    sys.stdout.write(json.dumps(output, ensure_ascii=False))
    return 0


def infer_title(result, source: Path) -> str:
    title = getattr(result, "title", None)
    if title and str(title).strip():
        return str(title).strip()
    return source.stem


def infer_source_type(source: Path) -> str:
    ext = source.suffix.lower()
    if ext == ".pdf":
      return "pdf"
    if ext in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
      return "image"
    if ext in {".mp3", ".wav", ".m4a"}:
      return "audio"
    if ext in {".mp4", ".mov", ".mkv"}:
      return "video"
    return "text"


if __name__ == "__main__":
    raise SystemExit(main())
