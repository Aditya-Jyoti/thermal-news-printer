"""`python -m tnp.api` starts the API server on TNP_API_HOST:TNP_API_PORT."""
import uvicorn

from tnp.config import load_config


def main() -> None:
    cfg = load_config()
    uvicorn.run("tnp.api.app:app", host=cfg.api_host, port=cfg.api_port)


if __name__ == "__main__":
    main()
