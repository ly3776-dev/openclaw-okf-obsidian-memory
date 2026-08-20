#!/usr/bin/env python3
import argparse
import json
import os
import sys
from pathlib import Path
from model_sources import download_modelscope, model_dir, use_modelscope


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", nargs="?")
    parser.add_argument("--model", default=os.environ.get("OKF_FASTER_WHISPER_MODEL", "tiny"))
    parser.add_argument("--model-path", default=os.environ.get("OKF_FASTER_WHISPER_MODEL_PATH"))
    parser.add_argument("--language", default=None)
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--allow-model-download", action="store_true")
    args = parser.parse_args()

    allow_download = args.allow_model_download or os.environ.get("OKF_ALLOW_MODEL_DOWNLOAD") == "1"
    if args.prepare:
        if not allow_download:
            raise RuntimeError("model preparation requires --allow-model-download / 模型预下载必须显式传入 --allow-model-download")
        load_faster_whisper_model(args, allow_download=True)
        write_output({
            "ok": True,
            "phase": "model_ready",
            "engine": "faster_whisper",
            "model": args.model_path or args.model
        })
        return 0

    if not args.input:
        parser.error("input is required unless --prepare is used")

    source = Path(args.input)
    failures = []
    funasr_model_path = os.environ.get("OKF_FUNASR_MODEL_PATH")
    if funasr_model_path:
        try:
            emit_phase("model_loading", "funasr", detail=funasr_model_path)
            text, language = transcribe_with_funasr(source, args.language, funasr_model_path)
            emit_phase("processing_complete", "funasr")
            write_output({
                "text": text,
                "title": source.stem,
                "source_type": infer_source_type(source),
                "language": language,
                "engine": "funasr",
                "warnings": []
            })
            return 0
        except Exception as error:
            failures.append(f"funasr: {error}")
            emit_phase("engine_failed", "funasr", detail=str(error))
    else:
        emit_phase("engine_skipped", "funasr", detail="OKF_FUNASR_MODEL_PATH is not configured; ingest never downloads it")

    try:
        model = load_faster_whisper_model(args, allow_download=allow_download)
        emit_phase("processing", "faster_whisper", detail=str(source))
        segments, info = model.transcribe(str(source), language=args.language, vad_filter=True)
        lines = []
        for segment in segments:
            text = segment.text.strip()
            if text:
                lines.append(f"[{format_time(segment.start)} - {format_time(segment.end)}] {text}")
        emit_phase("processing_complete", "faster_whisper")
        write_output({
            "text": "\n".join(lines),
            "title": source.stem,
            "source_type": infer_source_type(source),
            "language": getattr(info, "language", None),
            "engine": "faster_whisper",
            "duration": getattr(info, "duration", None),
            "warnings": failures
        })
        return 0
    except Exception as error:
        failures.append(f"faster_whisper: {error}")
        emit_phase("engine_failed", "faster_whisper", detail=str(error))
        raise RuntimeError(
            "transcription failed without downloading models during ingest; "
            "run transcribe_media.py --prepare --allow-model-download first or configure a local model. "
            "/ ingest 转录失败且不会自动下载模型；请先运行 --prepare --allow-model-download 或配置本地模型。 "
            + " | ".join(failures)
        ) from error


def load_faster_whisper_model(args, allow_download: bool):
    from faster_whisper import WhisperModel

    prepared_dir = model_dir("faster-whisper", args.model)
    prepared_ready = (prepared_dir / "model.bin").is_file() and (prepared_dir / "config.json").is_file()
    model_ref = args.model_path or (str(prepared_dir) if prepared_ready else args.model)
    if allow_download and not args.model_path and use_modelscope():
        from faster_whisper.utils import _MODELS
        repo_id = args.model if "/" in args.model else _MODELS.get(args.model)
        if not repo_id:
            raise RuntimeError(f"Unknown Faster-Whisper model for ModelScope: {args.model}")
        emit_phase("model_download", "modelscope", detail=repo_id)
        model_ref = str(download_modelscope(repo_id, prepared_dir, allow_patterns=[
            "config.json", "preprocessor_config.json", "model.bin",
            "tokenizer.json", "vocabulary.*"
        ]))
    if allow_download and not args.model_path:
        emit_phase("model_download", "faster_whisper", detail=model_ref)
    emit_phase("model_loading", "faster_whisper", detail=model_ref)
    return WhisperModel(
        model_ref,
        device="cpu",
        compute_type="int8",
        local_files_only=not allow_download
    )


def transcribe_with_funasr(source: Path, language: str | None, model_path: str):
    from funasr import AutoModel

    vad_model = os.environ.get("OKF_FUNASR_VAD_MODEL_PATH")
    punc_model = os.environ.get("OKF_FUNASR_PUNC_MODEL_PATH")
    model = AutoModel(
        model=model_path,
        vad_model=vad_model,
        punc_model=punc_model,
        device="cpu",
        disable_update=True
    )
    emit_phase("processing", "funasr", detail=str(source))
    kwargs = {}
    if language:
        kwargs["language"] = language
    result = model.generate(input=str(source), batch_size_s=300, **kwargs)
    text_parts = []
    for item in result if isinstance(result, list) else [result]:
        if isinstance(item, dict):
            text = item.get("text") or item.get("preds") or item.get("sentence")
            if text:
                text_parts.append(str(text).strip())
        else:
            text = getattr(item, "text", None)
            if text:
                text_parts.append(str(text).strip())
    return "\n".join(part for part in text_parts if part), "zh"


def format_time(seconds: float) -> str:
    seconds = max(0, int(seconds))
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def infer_source_type(source: Path) -> str:
    if source.suffix.lower() in {".mp3", ".wav", ".m4a"}:
        return "audio"
    return "video"


def emit_phase(phase: str, engine: str, detail: str | None = None) -> None:
    payload = {"event": "transcription_phase", "phase": phase, "engine": engine}
    if detail:
        payload["detail"] = detail
    sys.stderr.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stderr.flush()


def write_output(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    raise SystemExit(main())
