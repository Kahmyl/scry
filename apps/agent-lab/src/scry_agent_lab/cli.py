from __future__ import annotations

import argparse
import asyncio
import json
import os
import uuid
from datetime import UTC, datetime
from pathlib import Path

from .agent import run_agent
from .config import model_config
from .mcp_client import ScryMcpClient
from .models import OpenAICompatibleModel
from .transcript import Transcript
from .types import AgentRunSpec


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        prog="scry-agent-lab",
        description=(
            "Run a black-box external model against Scry MCP."
        ),
    )

    commands = root.add_subparsers(
        dest="command",
        required=True,
    )

    inspect = commands.add_parser(
        "inspect",
        help="Inspect exactly what an external MCP client sees.",
    )
    inspect.add_argument(
        "--mcp-url",
        default="http://127.0.0.1:4100/mcp",
    )

    run = commands.add_parser(
        "run",
        help="Run the local external agent against Scry MCP.",
    )
    run.add_argument(
        "--objective",
        required=True,
    )
    run.add_argument(
        "--mcp-url",
        default="http://127.0.0.1:4100/mcp",
    )
    run.add_argument(
        "--provider",
        choices=["local", "deepseek"],
        default="local",
    )
    run.add_argument(
        "--model",
        default=None,
    )
    run.add_argument(
        "--profile",
        choices=["smoke", "capable_live_journey"],
        default="smoke",
    )
    run.add_argument(
        "--max-turns",
        type=int,
        default=None,
    )
    run.add_argument(
        "--max-tool-calls",
        type=int,
        default=None,
    )
    run.add_argument(
        "--max-wall-time-seconds",
        type=int,
        default=None,
    )
    run.add_argument(
        "--external-run-id",
        default=None,
    )
    run.add_argument(
        "--experiment-id",
        default=None,
    )
    run.add_argument(
        "--output-directory",
        default=None,
    )
    for option in (
        "attempt-id",
        "campaign-id",
        "mission-id",
        "objective-id",
        "agent-session-id",
    ):
        run.add_argument(f"--expected-{option}", default=None)

    return root


def token() -> str:
    value = os.getenv("SCRY_AGENT_LAB_MCP_TOKEN")
    if not value:
        raise RuntimeError(
            "SCRY_AGENT_LAB_MCP_TOKEN_REQUIRED"
        )
    return value


async def inspect_mcp(url: str) -> int:
    async with ScryMcpClient(url, token()) as mcp:
        snapshot = await mcp.snapshot()

    print(
        snapshot.model_dump_json(
            indent=2,
        )
    )
    return 0


def default_run_directory() -> Path:
    timestamp = datetime.now(UTC).strftime(
        "%Y%m%dT%H%M%SZ"
    )
    return (
        Path("apps/agent-lab/.runs")
        / f"{timestamp}-{uuid.uuid4().hex[:8]}"
    )


async def run_command(args: argparse.Namespace) -> int:
    output_directory = (
        Path(args.output_directory)
        if args.output_directory
        else default_run_directory()
    )
    output_directory.mkdir(
        parents=True,
        exist_ok=True,
    )

    transcript = Transcript(
        output_directory / "transcript.jsonl"
    )

    config = model_config(args.provider, args.model)
    model = OpenAICompatibleModel(config)
    external_run_id = args.external_run_id or str(uuid.uuid4())
    experiment_id = args.experiment_id or external_run_id

    spec = AgentRunSpec(
        objective=args.objective,
        mcp_url=args.mcp_url,
        profile=args.profile,
        max_turns=args.max_turns,
        max_tool_calls=args.max_tool_calls,
        max_wall_time_seconds=args.max_wall_time_seconds,
        external_run_id=external_run_id,
        experiment_id=experiment_id,
        expected_attempt_id=args.expected_attempt_id,
        expected_campaign_id=args.expected_campaign_id,
        expected_mission_id=args.expected_mission_id,
        expected_objective_id=args.expected_objective_id,
        expected_agent_session_id=args.expected_agent_session_id,
    )

    async with ScryMcpClient(
        spec.mcp_url,
        token(),
        provider=config.provider,
        model=config.model,
        external_run_id=external_run_id,
        experiment_id=experiment_id,
        correlation_id=external_run_id,
    ) as mcp:
        try:
            result = await run_agent(
                spec=spec,
                model=model,
                mcp=mcp,
                transcript=transcript,
                model_name=config.model,
                provider_name=config.provider,
            )
        except asyncio.CancelledError:
            await mcp.terminate(
                "EXTERNAL_AGENT_HARNESS_CANCELLED"
            )
            raise
        except Exception:
            await mcp.terminate(
                "EXTERNAL_AGENT_UNRECOVERABLE_FAILURE"
            )
            raise

    result_path = output_directory / "result.json"
    result_path.write_text(
        result.model_dump_json(indent=2) + "\n",
        encoding="utf-8",
    )

    print(result.model_dump_json(indent=2))

    return 0 if result.status == "completed" else 1


async def async_main() -> int:
    args = parser().parse_args()

    if args.command == "inspect":
        return await inspect_mcp(args.mcp_url)

    if args.command == "run":
        try:
            return await run_command(args)
        except BaseException as error:
            output = (
                Path(args.output_directory)
                if args.output_directory
                else default_run_directory()
            )
            output.mkdir(parents=True, exist_ok=True)
            (output / "failure.json").write_text(
                json.dumps(
                    {
                        "status": "failed",
                        "failure": "AGENT_LAB_UNRECOVERABLE_FAILURE",
                        "errorClass": type(error).__name__,
                        "externalRunId": args.external_run_id,
                        "experimentId": args.experiment_id,
                    },
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            return 1

    raise RuntimeError("UNKNOWN_COMMAND")


def main() -> None:
    raise SystemExit(
        asyncio.run(async_main())
    )


if __name__ == "__main__":
    main()
