from __future__ import annotations

from mcp.types import Tool


def test_mcp_v2_tool_exposes_snake_case_schema() -> None:
    tool = Tool(
        name="echo",
        description="Echo a value.",
        input_schema={
            "type": "object",
            "properties": {
                "value": {
                    "type": "string",
                }
            },
        },
    )

    assert tool.input_schema == {
        "type": "object",
        "properties": {
            "value": {
                "type": "string",
            }
        },
    }

    assert not hasattr(
        tool,
        "inputSchema",
    )
