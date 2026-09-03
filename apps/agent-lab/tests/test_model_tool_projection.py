from __future__ import annotations

import json

import pytest

from scry_agent_lab.agent import (
    _model_tool_payload,
)


def duplicate_payload():
    structured = {
        "mission": {
            "id": "m1",
            "status": "running",
        }
    }

    return {
        "isError": False,
        "content": [
            {
                "type": "text",
                "text": json.dumps(
                    structured
                ),
            }
        ],
        "structuredContent": structured,
    }


def test_full_is_default(
    monkeypatch,
) -> None:
    monkeypatch.delenv(
        "SCRY_AGENT_LAB_TOOL_RESULT_PROJECTION",
        raising=False,
    )

    payload = duplicate_payload()

    assert (
        _model_tool_payload(payload)
        is payload
    )


def test_full_explicit(
    monkeypatch,
) -> None:
    monkeypatch.setenv(
        "SCRY_AGENT_LAB_TOOL_RESULT_PROJECTION",
        "full",
    )

    payload = duplicate_payload()

    assert (
        _model_tool_payload(payload)
        is payload
    )


def test_structured_removes_exact_duplicate(
    monkeypatch,
) -> None:
    monkeypatch.setenv(
        "SCRY_AGENT_LAB_TOOL_RESULT_PROJECTION",
        "structured",
    )

    payload = duplicate_payload()

    projected = _model_tool_payload(
        payload
    )

    assert projected == {
        "isError": False,
        "structuredContent":
            payload["structuredContent"],
    }

    assert "content" in payload


def test_structured_preserves_distinct_content(
    monkeypatch,
) -> None:
    monkeypatch.setenv(
        "SCRY_AGENT_LAB_TOOL_RESULT_PROJECTION",
        "structured",
    )

    payload = {
        "isError": False,
        "content": [
            {
                "type": "text",
                "text":
                    "additional factual explanation",
            }
        ],
        "structuredContent": {
            "status": "ok",
        },
    }

    assert (
        _model_tool_payload(payload)
        == payload
    )


def test_structured_preserves_no_structured_content(
    monkeypatch,
) -> None:
    monkeypatch.setenv(
        "SCRY_AGENT_LAB_TOOL_RESULT_PROJECTION",
        "structured",
    )

    payload = {
        "isError": False,
        "content": [
            {
                "type": "text",
                "text": "public value",
            }
        ],
        "structuredContent": None,
    }

    assert (
        _model_tool_payload(payload)
        == payload
    )


def test_invalid_projection_rejected(
    monkeypatch,
) -> None:
    monkeypatch.setenv(
        "SCRY_AGENT_LAB_TOOL_RESULT_PROJECTION",
        "something-else",
    )

    with pytest.raises(
        ValueError,
        match="must be 'full' or 'structured'",
    ):
        _model_tool_payload(
            duplicate_payload()
        )
