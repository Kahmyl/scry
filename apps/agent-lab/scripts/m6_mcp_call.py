from __future__ import annotations

import asyncio
import json
import os

from scry_agent_lab.mcp_client import ScryMcpClient


async def main() -> None:
    url = os.environ["SCRY_M6_MCP_URL"]
    token = os.environ["SCRY_M6_MCP_TOKEN"]
    tool = os.environ["SCRY_M6_MCP_TOOL"]
    arguments = json.loads(os.environ["SCRY_M6_MCP_ARGUMENTS"])
    async with ScryMcpClient(url, token, provider="m6-deterministic-adversary") as client:
        snapshot = await client.snapshot()
        result = await client.call_tool(tool, arguments)
    print(
        json.dumps(
            {
                "protocolVersion": snapshot.protocol_version,
                "serverInfo": snapshot.server_info,
                "toolNames": sorted(item.name for item in snapshot.tools),
                "result": result.model_dump(mode="json", by_alias=True, exclude_none=True),
            }
        )
    )


asyncio.run(main())
