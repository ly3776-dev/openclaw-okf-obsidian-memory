#!/usr/bin/env python3
import shutil
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: mock_douyin_download.py <input> <output>")
        return 1
    source = Path(sys.argv[1])
    output = Path(sys.argv[2])
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, output)
    print(f"mock downloaded {source} -> {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
