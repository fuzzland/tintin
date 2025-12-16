#!/usr/bin/env python3

import argparse
import os
import platform
from datetime import datetime, timezone


def main() -> None:
    parser = argparse.ArgumentParser(description="Tintin demo project: hello world")
    parser.add_argument("--name", default="world", help="Name to greet")
    args = parser.parse_args()

    now = datetime.now(timezone.utc).isoformat()
    print(f"hello, {args.name}!")
    print(f"cwd: {os.getcwd()}")
    print(f"python: {platform.python_version()}")
    print(f"time_utc: {now}")


if __name__ == "__main__":
    main()

