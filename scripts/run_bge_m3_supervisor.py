#!/usr/bin/env python3
"""Cross-platform BGE-M3 supervisor with health checks and bounded log rotation."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

STOPPING = False


class WindowsKillJob:
    """Kill the complete server tree if the supervisor handle is closed."""

    def __init__(self) -> None:
        self.handle = None
        if os.name != "nt":
            return
        import ctypes
        from ctypes import wintypes

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class BASIC_LIMITS(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD),
            ]

        class EXTENDED_LIMITS(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BASIC_LIMITS), ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = EXTENDED_LIMITS()
        limits.BasicLimitInformation.LimitFlags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            kernel32.CloseHandle(handle)
            raise ctypes.WinError(ctypes.get_last_error())
        self.handle = handle
        self._kernel32 = kernel32

    def assign(self, process: subprocess.Popen[bytes]) -> None:
        if self.handle is None:
            return
        import ctypes
        if not self._kernel32.AssignProcessToJobObject(self.handle, ctypes.c_void_p(process._handle)):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self) -> None:
        if self.handle is not None:
            self._kernel32.CloseHandle(self.handle)
            self.handle = None


def rotate(path: Path, max_bytes: int, backups: int) -> None:
    if not path.exists() or path.stat().st_size < max_bytes:
        return
    oldest = path.with_suffix(path.suffix + f".{backups}")
    oldest.unlink(missing_ok=True)
    for number in range(backups - 1, 0, -1):
        source = path.with_suffix(path.suffix + f".{number}")
        if source.exists():
            source.replace(path.with_suffix(path.suffix + f".{number + 1}"))
    path.replace(path.with_suffix(path.suffix + ".1"))


def healthy(url: str, api_key: str, timeout: float = 5.0) -> bool:
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status == 200 and bool(json.loads(response.read().decode("utf-8")).get("data"))
    except Exception:
        return False


def stop_process_tree(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], check=False, capture_output=True)
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=10)
        except Exception:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8008)
    parser.add_argument("--api-key", default="okf-local")
    parser.add_argument("--model", default="BAAI/bge-m3")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--backend", default="sentence-transformers")
    parser.add_argument("--model-cache-dir", default="")
    parser.add_argument("--log-dir", default="")
    parser.add_argument("--health-interval", type=float, default=30.0)
    parser.add_argument("--startup-timeout", type=float, default=600.0)
    parser.add_argument("--restart-delay", type=float, default=5.0)
    parser.add_argument("--max-log-bytes", type=int, default=10 * 1024 * 1024)
    parser.add_argument("--log-backups", type=int, default=5)
    parser.add_argument("--python", default=sys.executable)
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    log_dir = Path(args.log_dir).resolve() if args.log_dir else root / ".logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    out_log, err_log = log_dir / "bge-m3.out.log", log_dir / "bge-m3.err.log"
    health_url = f"http://{args.host}:{args.port}/v1/models"

    def request_stop(_signum: int, _frame: object) -> None:
        global STOPPING
        STOPPING = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    while not STOPPING:
        rotate(out_log, args.max_log_bytes, args.log_backups)
        rotate(err_log, args.max_log_bytes, args.log_backups)
        command = [
            args.python, str(root / "scripts" / "bge_m3_embedding_server.py"),
            "--host", args.host, "--port", str(args.port), "--api-key", args.api_key,
            "--model", args.model, "--device", args.device, "--backend", args.backend,
        ]
        if args.model_cache_dir:
            command += ["--model-cache-dir", args.model_cache_dir]
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        popen_kwargs = {"cwd": root, "creationflags": creationflags}
        if os.name != "nt":
            popen_kwargs["start_new_session"] = True
        with out_log.open("ab") as stdout, err_log.open("ab") as stderr:
            job = WindowsKillJob()
            process = subprocess.Popen(command, stdout=stdout, stderr=stderr, **popen_kwargs)
            try:
                job.assign(process)
            except Exception:
                stop_process_tree(process)
                job.close()
                raise
            started = time.monotonic()
            unhealthy_since = None
            while not STOPPING and process.poll() is None:
                ok = healthy(health_url, args.api_key)
                if ok:
                    unhealthy_since = None
                elif unhealthy_since is None:
                    unhealthy_since = time.monotonic()
                elif time.monotonic() - unhealthy_since >= args.startup_timeout:
                    break
                time.sleep(max(1.0, args.health_interval))
            stop_process_tree(process)
            job.close()
        if not STOPPING:
            time.sleep(max(1.0, args.restart_delay))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
