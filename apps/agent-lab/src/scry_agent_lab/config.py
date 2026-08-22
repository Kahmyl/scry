from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ModelConfig:
    provider: str
    model: str
    base_url: str
    api_key: str
    temperature: float | None
    seed: int | None
    max_tokens: int
    extra_body: dict[str, Any] | None = None


def model_config(
    provider: str,
    model_override: str | None = None,
) -> ModelConfig:
    if provider == "local":
        return ModelConfig(
            provider="ollama",
            model=(
                model_override
                or os.getenv(
                    "SCRY_AGENT_LAB_MODEL",
                    "scry-agent-local",
                )
            ),
            base_url=os.getenv(
                "SCRY_AGENT_LAB_MODEL_BASE_URL",
                "http://127.0.0.1:11434/v1",
            ),
            api_key=os.getenv(
                "SCRY_AGENT_LAB_MODEL_API_KEY",
                "ollama",
            ),
            temperature=float(
                os.getenv(
                    "SCRY_AGENT_LAB_TEMPERATURE",
                    "0.1",
                )
            ),
            seed=int(
                os.getenv(
                    "SCRY_AGENT_LAB_SEED",
                    "42",
                )
            ),
            max_tokens=int(
                os.getenv(
                    "SCRY_AGENT_LAB_MAX_TOKENS",
                    "2048",
                )
            ),
        )

    if provider == "deepseek":
        api_key = (
            os.getenv("DEEPSEEK_API_KEY")
            or os.getenv(
                "SCRY_AGENT_LAB_DEEPSEEK_API_KEY"
            )
        )

        if not api_key:
            raise RuntimeError(
                "DEEPSEEK_API_KEY_REQUIRED"
            )

        return ModelConfig(
            provider="deepseek",
            model=(
                model_override
                or os.getenv(
                    "SCRY_AGENT_LAB_DEEPSEEK_MODEL",
                    "deepseek-v4-flash",
                )
            ),
            base_url="https://api.deepseek.com",
            api_key=api_key,
            temperature=0.1,
            seed=None,
            max_tokens=int(
                os.getenv(
                    "SCRY_AGENT_LAB_DEEPSEEK_MAX_TOKENS",
                    "2048",
                )
            ),
            extra_body={
                "thinking": {
                    "type": "disabled",
                }
            },
        )

    raise RuntimeError(
        f"UNKNOWN_MODEL_PROVIDER:{provider}"
    )
