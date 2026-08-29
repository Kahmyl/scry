from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


class Transcript:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def write(self, event: str, data: dict[str, Any]) -> None:
        record = {
            "timestamp": datetime.now(UTC).isoformat(),
            "event": event,
            "data": _safe(data),
        }
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, default=str))
            handle.write("\n")


_PROTECTED_KEYS = {
    "authorization",
    "cookie",
    "set-cookie",
    "api_key",
    "apikey",
    "password",
    "secret",
    "token",
    "protectedplaintext",
    "protectedrequestbody",
    "protectedoutputvalue",
}


def _canaries() -> list[str]:
    encoded = os.getenv("SCRY_AGENT_LAB_PROTECTED_CANARIES", "[]")
    try:
        values = json.loads(encoded)
    except Exception:
        return []
    return [value for value in values if isinstance(value, str) and value]


def _safe(value: Any, key: str = "") -> Any:
    normalized = key.lower().replace("_", "").replace("-", "")
    if any(
        marker.replace("_", "").replace("-", "") in normalized
        for marker in _PROTECTED_KEYS
    ):
        return "[REDACTED]"
    if isinstance(value, str):
        safe = value
        for canary in _canaries():
            safe = safe.replace(canary, "[REDACTED]")
        return safe
    if isinstance(value, dict):
        return {name: _safe(candidate, name) for name, candidate in value.items()}
    if isinstance(value, list):
        return [_safe(candidate, key) for candidate in value]
    return value
