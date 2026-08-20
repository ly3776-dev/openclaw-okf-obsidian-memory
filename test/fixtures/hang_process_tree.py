#!/usr/bin/env python3
import subprocess
import sys
import time
from pathlib import Path


if "--child" in sys.argv:
    while True:
        time.sleep(1)
else:
    pid_file = Path(sys.argv[1])
    child = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--child"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    pid_file.write_text(str(child.pid), encoding="utf-8")
    while True:
        time.sleep(1)
