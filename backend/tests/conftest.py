import pytest

from tnp import db
from tnp.seed import seed_defaults


@pytest.fixture(autouse=True)
def _no_network_ai(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv("TNP_SCHEDULER", "0")


@pytest.fixture(autouse=True)
def _no_network_fulltext(monkeypatch):
    # Full-text enrichment must never hit the network in tests; enrichment tests install their own fake.
    monkeypatch.setattr("tnp.ingest.enrich.fetch_full_text", lambda url, *, client: (None, None))


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    db.init_db(c)
    seed_defaults(c)
    yield c
    c.close()


@pytest.fixture(autouse=True)
def _no_network_ai(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv("TNP_SCHEDULER", "0")
