#!/usr/bin/env python3
"""Explicitly download and load the BGE-M3 model during install/doctor."""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from model_sources import download_modelscope, model_dir, use_modelscope


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="BAAI/bge-m3")
    parser.add_argument("--model-cache-dir", default="")
    parser.add_argument("--hf-endpoint", default="")
    args = parser.parse_args()
    if args.hf_endpoint:
        os.environ["HF_ENDPOINT"] = args.hf_endpoint

    started = time.monotonic()
    print(json.dumps({"phase": "model_download", "model": args.model}, ensure_ascii=False), flush=True)
    from sentence_transformers import SentenceTransformer

    kwargs = {}
    model_ref = args.model
    if use_modelscope():
        destination = Path(args.model_cache_dir).expanduser().resolve() if args.model_cache_dir else model_dir("bge-m3", args.model)
        model_ref = str(download_modelscope(args.model, destination, allow_patterns=[
            "1_Pooling/config.json", "config.json", "config_sentence_transformers.json",
            "modules.json", "pytorch_model.bin", "sentence_bert_config.json",
            "sentencepiece.bpe.model", "special_tokens_map.json", "tokenizer.json",
            "tokenizer_config.json"
        ]))
    elif args.model_cache_dir:
        kwargs["cache_folder"] = args.model_cache_dir
    model = SentenceTransformer(model_ref, device="cpu", **kwargs)
    print(json.dumps({"phase": "model_loading", "model": args.model}, ensure_ascii=False), flush=True)
    dimension_method = getattr(model, "get_embedding_dimension", model.get_sentence_embedding_dimension)
    dims = int(dimension_method())
    elapsed = round(time.monotonic() - started, 3)
    print(json.dumps({"ok": True, "phase": "ready", "model": args.model, "modelPath": model_ref, "dimensions": dims, "elapsedSeconds": elapsed}, ensure_ascii=False))


if __name__ == "__main__":
    main()
