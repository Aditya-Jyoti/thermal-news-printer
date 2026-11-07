"""Runtime settings read from environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    openrouter_api_key: str | None = None
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    model: str = "google/gemma-3-12b-it"
    fallback_model: str | None = "deepseek/deepseek-v4.1-flash"
    db_path: str = "./data/tnp.sqlite3"
    api_host: str = "0.0.0.0"
    api_port: int = 8000


def load_config(env: dict[str, str] | None = None) -> Config:
    e = os.environ if env is None else env
    d = Config()
    return Config(
        openrouter_api_key=e.get("OPENROUTER_API_KEY") or None,
        openrouter_base_url=e.get("OPENROUTER_BASE_URL", d.openrouter_base_url),
        model=e.get("TNP_MODEL", d.model),
        fallback_model=e.get("TNP_FALLBACK_MODEL", d.fallback_model) or None,
        db_path=e.get("TNP_DB_PATH", d.db_path),
        api_host=e.get("TNP_API_HOST", d.api_host),
        api_port=int(e.get("TNP_API_PORT", d.api_port)),
    )
