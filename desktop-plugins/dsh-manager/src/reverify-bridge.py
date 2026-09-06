#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""stdin JSON args → reverify MCP tool dispatcher → stdout JSON."""

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CANDIDATES = [
    HERE / "vendor" / "reverify",
    HERE.parent / "vendor" / "reverify",
]
for root in CANDIDATES:
    if (root / "reverify" / "mcp_server.py").exists():
        sys.path.insert(0, str(root))
        break

from reverify.mcp_server import handle_tool_call  # noqa: E402


def main() -> int:
    name = sys.argv[1] if len(sys.argv) > 1 else ""
    raw = sys.stdin.read() or "{}"
    try:
        arguments = json.loads(raw)
    except json.JSONDecodeError as error:
        sys.stdout.write(json.dumps({"error": f"invalid tool arguments: {error}"}))
        return 1
    if not isinstance(arguments, dict):
        arguments = {}
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    text = handle_tool_call(name, arguments)
    sys.stdout.write(text if text.endswith("\n") else text + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
