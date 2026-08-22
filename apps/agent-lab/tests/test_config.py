from __future__ import annotations

import pytest

from scry_agent_lab.config import (
    model_config,
)


def test_local_provider_is_ollama() -> None:
    config = model_config("local")

    assert config.provider == "ollama"
    assert config.model == "scry-agent-local"
    assert (
        config.base_url
        == "http://127.0.0.1:11434/v1"
    )


def test_deepseek_provider(
    monkeypatch,
) -> None:
    monkeypatch.setenv(
        "DEEPSEEK_API_KEY",
        "test-key",
    )

    config = model_config(
        "deepseek"
    )

    assert config.provider == "deepseek"
    assert (
        config.model
        == "deepseek-v4-flash"
    )
    assert (
        config.base_url
        == "https://api.deepseek.com"
    )
    assert config.seed is None
    assert config.extra_body == {
        "thinking": {
            "type": "disabled",
        }
    }


def test_deepseek_requires_key(
    monkeypatch,
) -> None:
    monkeypatch.delenv(
        "DEEPSEEK_API_KEY",
        raising=False,
    )
    monkeypatch.delenv(
        "SCRY_AGENT_LAB_DEEPSEEK_API_KEY",
        raising=False,
    )

    with pytest.raises(
        RuntimeError,
        match="DEEPSEEK_API_KEY_REQUIRED",
    ):
        model_config(
            "deepseek"
        )
