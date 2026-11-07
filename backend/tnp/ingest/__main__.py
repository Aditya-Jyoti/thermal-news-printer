"""CLI: `python -m tnp.ingest [feed_id]` ingests feeds and prints the IngestResult."""
from __future__ import annotations

import sys

from tnp import db
from tnp.config import load_config
from tnp.ingest.service import run_ingest
from tnp.seed import seed_defaults


def main() -> None:
    conn = db.connect(load_config().db_path)
    db.init_db(conn)
    seed_defaults(conn)
    feed_id = int(sys.argv[1]) if len(sys.argv) > 1 else None
    print(run_ingest(conn, feed_id).model_dump_json(indent=2))


if __name__ == "__main__":
    main()
