#!/usr/bin/env python3
import argparse
import json
import os
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", nargs="?")
    parser.add_argument("--prepare", action="store_true")
    args = parser.parse_args()

    os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "0")
    # ModelScope is reachable in mainland China and avoids a hidden first-use
    # dependency on huggingface.co. Operators can still override this variable.
    os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "modelscope")
    from paddleocr import PaddleOCR

    engine = PaddleOCR(
        lang="ch",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False
    )
    if args.prepare:
        sys.stdout.write(json.dumps({
            "ok": True,
            "phase": "model_ready",
            "engine": "paddleocr",
            "model_source": os.environ.get("PADDLE_PDX_MODEL_SOURCE")
        }, ensure_ascii=False))
        return 0
    if not args.input:
        parser.error("input is required unless --prepare is used")
    source = Path(args.input)
    result = engine.predict(str(source))
    text = collect_text(result)
    output = {
        "text": text,
        "title": source.stem,
        "source_type": infer_source_type(source),
        "warnings": []
    }
    sys.stdout.write(json.dumps(output, ensure_ascii=False))
    return 0


def collect_text(result) -> str:
    if result is None:
        return ""
    pieces = []
    for item in result:
        if isinstance(item, dict):
            rec_texts = item.get("rec_texts")
            if isinstance(rec_texts, list):
                pieces.extend(str(text) for text in rec_texts)
            for key in ("rec_text", "text", "transcription"):
                value = item.get(key)
                if value:
                    pieces.append(str(value))
        else:
            rec_texts = getattr(item, "rec_texts", None)
            if isinstance(rec_texts, list):
                pieces.extend(str(text) for text in rec_texts)
            text = getattr(item, "rec_text", None) or getattr(item, "text", None)
            if text:
                pieces.append(str(text))
    return "\n".join(piece.strip() for piece in pieces if str(piece).strip())


def infer_source_type(source: Path) -> str:
    ext = source.suffix.lower()
    if ext == ".pdf":
        return "pdf"
    return "image"


if __name__ == "__main__":
    raise SystemExit(main())
