import pytest

from tnp import db
from tnp.seed import seed_defaults


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite3")
    db.init_db(c)
    seed_defaults(c)
    yield c
    c.close()
