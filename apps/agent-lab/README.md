# Scry Agent Lab

Agent Lab is a local black-box external-agent simulator for Scry.

It intentionally has no dependency on Scry implementation packages. Its Scry
interface is the public MCP endpoint only.

## Local model

The default model is `scry-agent-local`, created from `qwen3.5:9b` with a
32,768-token context.

From the repository root:

    ollama pull qwen3.5:9b
    ollama create scry-agent-local -f apps/agent-lab/models/qwen3.5-9b.Modelfile

The model is only needed while running experiments. Unload it with:

    ollama stop scry-agent-local

## Scry MCP

The default MCP URL is:

    http://127.0.0.1:4100/mcp

Agent Lab reads the MCP bearer token from:

    SCRY_AGENT_LAB_MCP_TOKEN

Inspect the exact external MCP surface:

    uv run --project apps/agent-lab scry-agent-lab inspect

Run an objective:

    uv run --project apps/agent-lab scry-agent-lab run \
      --objective "Complete the requested task using Scry."

Every run writes:

- `result.json`
- `transcript.jsonl`

under `apps/agent-lab/.runs/`.

Agent Lab does not decide qualification PASS or FAIL. Assurance owns claims,
oracles, evidence interpretation, and qualification.

## DeepSeek challenger

Agent Lab can run the same external-agent objective through DeepSeek V4 Flash:

    DEEPSEEK_API_KEY=... \
      pnpm assurance:agent \
      --provider deepseek \
      --objective "..."

The default DeepSeek profile uses `deepseek-v4-flash` in non-thinking mode.
This keeps its tool-call loop directly comparable with the local model.

DeepSeek is a separate experimental/qualification result. A DeepSeek success
must never silently turn a failed local-model qualification into a PASS.
