"""Deterministic install-time model downloads for domestic/global profiles."""

import os
import re
from pathlib import Path


def model_cache_root() -> Path:
    explicit = os.environ.get("OKF_MODEL_CACHE_DIR")
    if explicit:
        return Path(explicit).expanduser().resolve()
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        return base / "OKF Obsidian Memory" / "models"
    base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / "okf-obsidian-memory" / "models"


def model_dir(kind: str, model_name: str) -> Path:
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", model_name).strip("-") or "model"
    return model_cache_root() / kind / safe_name


def download_modelscope(repo_id: str, destination: Path, allow_patterns=None) -> Path:
    from modelscope.hub.snapshot_download import snapshot_download

    destination.mkdir(parents=True, exist_ok=True)
    result = snapshot_download(
        repo_id,
        revision="master",
        local_dir=str(destination),
        allow_patterns=allow_patterns,
        max_workers=4,
    )
    return Path(result).resolve()


def use_modelscope() -> bool:
    return os.environ.get("OKF_MODEL_HUB", "").strip().lower() == "modelscope"
