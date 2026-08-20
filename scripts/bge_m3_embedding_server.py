#!/usr/bin/env python3
"""
OpenAI-compatible embedding server for BGE-M3.

Install optional dependencies:
  python -m pip install FlagEmbedding fastapi uvicorn

Run:
  python scripts/bge_m3_embedding_server.py --host 127.0.0.1 --port 8008

Endpoint:
  POST /v1/embeddings
"""

import argparse
import os
import sys
import time
from typing import Any
from model_sources import model_dir

import uvicorn
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel


class EmbeddingRequest(BaseModel):
    model: str = "BAAI/bge-m3"
    input: str | list[str]


def normalize(vector: list[float]) -> list[float]:
    norm = sum(value * value for value in vector) ** 0.5 or 1.0
    return [round(value / norm, 8) for value in vector]


def build_app(model_name: str, device: str, api_key: str, model_cache_dir: str = "", backend: str = "sentence-transformers") -> FastAPI:
    if model_cache_dir:
        os.environ.setdefault("HF_HOME", model_cache_dir)
        os.environ.setdefault("TRANSFORMERS_CACHE", model_cache_dir)
    print(f"[bge-m3] loading model={model_name} backend={backend} device={device} hf_endpoint={os.environ.get('HF_ENDPOINT', '')}", flush=True)
    encoder = load_encoder(model_name, device, backend)
    print("[bge-m3] model loaded; starting OpenAI-compatible server", flush=True)
    app = FastAPI(title="OKF BGE-M3 Embedding Server")

    @app.get("/v1/models")
    def list_models() -> dict[str, Any]:
        return {
            "object": "list",
            "data": [
                {
                    "id": model_name,
                    "object": "model",
                    "created": 0,
                    "owned_by": "local"
                }
            ]
        }

    @app.post("/v1/embeddings")
    def embeddings(request: EmbeddingRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
        if api_key:
            expected = f"Bearer {api_key}"
            if authorization != expected:
                raise HTTPException(status_code=401, detail="invalid api key")

        texts = [request.input] if isinstance(request.input, str) else request.input
        started = time.time()
        dense_vectors = encoder(texts)
        data = []
        for index, vector in enumerate(dense_vectors):
            values = vector.tolist() if hasattr(vector, "tolist") else list(vector)
            data.append({
                "object": "embedding",
                "index": index,
                "embedding": normalize([float(value) for value in values])
            })
        prompt_tokens = sum(len(text) for text in texts)
        return {
            "object": "list",
            "model": request.model or model_name,
            "data": data,
            "usage": {
                "prompt_tokens": prompt_tokens,
                "total_tokens": prompt_tokens
            },
            "latency_ms": round((time.time() - started) * 1000)
        }

    return app


def load_encoder(model_name: str, device: str, backend: str):
    prepared = model_dir("bge-m3", model_name)
    model_ref = str(prepared) if (prepared / "config.json").is_file() else model_name
    if backend == "flagembedding":
        try:
            from FlagEmbedding import BGEM3FlagModel
        except Exception as error:
            raise RuntimeError("Missing dependency. Run: python -m pip install FlagEmbedding fastapi uvicorn") from error
        model = BGEM3FlagModel(model_ref, use_fp16=device != "cpu", device=device)

        def encode(texts: list[str]):
            encoded = model.encode(texts, return_dense=True, return_sparse=False, return_colbert_vecs=False)
            return encoded["dense_vecs"]

        return encode

    try:
        from sentence_transformers import SentenceTransformer
    except Exception as error:
        raise RuntimeError("Missing dependency. Run: python -m pip install sentence-transformers fastapi uvicorn") from error
    try:
        model = SentenceTransformer(
            model_ref,
            device=device,
            local_files_only=True,
        )
    except Exception as error:
        raise RuntimeError(
            "BGE-M3 is not available in the local cache. Run scripts/prepare_bge_m3.py during install. "
            "/ 本地缓存中没有 BGE-M3，请在安装阶段运行 scripts/prepare_bge_m3.py。"
        ) from error

    def encode(texts: list[str]):
        return model.encode(texts, normalize_embeddings=False)

    return encode


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="BAAI/bge-m3")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8008)
    parser.add_argument("--api-key", default="okf-local")
    parser.add_argument("--model-cache-dir", default="")
    parser.add_argument("--backend", choices=["sentence-transformers", "flagembedding"], default="sentence-transformers")
    args = parser.parse_args()
    try:
        app = build_app(args.model, args.device, args.api_key, args.model_cache_dir, args.backend)
    except Exception as error:
        print(f"[bge-m3] startup failed: {error}", file=sys.stderr, flush=True)
        raise
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
