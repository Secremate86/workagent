from __future__ import annotations

import json
import sys
from typing import Any

from .worker import run_request


def main() -> int:
    try:
        raw = sys.stdin.readline()
        if not raw:
            raise ValueError("stdin must contain one JSON request line")
        request: Any = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError("request must be a JSON object")
        result = run_request(request)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
