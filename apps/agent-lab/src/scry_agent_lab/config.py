from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class ModelConfig:
    model: str
    base_url: str
    api_key: str
    temperature: float
    seed: int
    max_tokens: int


def local_model_config(model_override: str | None = None) -> ModelConfig:
    return ModelConfig(
        model=model_override or os.getenv("SCRY_AGENT_LAB_MODEL", "scry-agent:local"),
        base_url=os.getenv(
            "SCRY_AGENT_LAB_MODEL_BASE_URL",
            "http://127.0.0.1:11434/v1",
        ),
        api_key=os.getenv("SCRY_AGENT_LAB_MODEL_API_KEY", "ollama"),
        temperature=float(os.getenv("SCRY_AGENT_LAB_TEMPERATURE", "0.1")),
        seed=int(os.getenv("SCRY_AGENT_LAB_SEED", "42")),
        max_tokens=int(os.getenv("SCRY_AGENT_LAB_MAX_TOKENS", "2048")),
    )
