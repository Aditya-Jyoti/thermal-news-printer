"""CLI: python -m tnp.print preview [--out f.png] [--sample] | scan | test"""
from __future__ import annotations

import argparse
import asyncio
import logging
from datetime import datetime
from pathlib import Path

from tnp.models import DigestItem


def _items(sample: bool) -> list[DigestItem]:
    if sample:
        from tnp.print.samples import sample_items

        return sample_items()
    from tnp import db
    from tnp.config import load_config
    from tnp.pipeline import build_digest

    conn = db.connect(load_config().db_path)
    try:
        db.init_db(conn)
        return build_digest(conn)
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="tnp.print")
    sub = p.add_subparsers(dest="cmd", required=True)
    pv = sub.add_parser("preview", help="render the current digest to a PNG")
    pv.add_argument("--out", default="preview.png")
    pv.add_argument("--sample", action="store_true", help="use built-in sample stories")
    sc = sub.add_parser("scan", help="scan for BLE cat printers")
    sc.add_argument("--timeout", type=float, default=8.0)
    ts = sub.add_parser("test", help="print a small test receipt")
    ts.add_argument("--address", default=None)
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO)

    from tnp.print.render import render_receipt

    if args.cmd == "preview":
        img = render_receipt(_items(args.sample), edition_date=datetime.now())
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        img.save(args.out)
        print(f"wrote {args.out} ({img.width}x{img.height})")
    elif args.cmd == "scan":
        from tnp.print.catprinter import scan

        found = asyncio.run(scan(args.timeout))
        for name, addr in found:
            print(f"{name}\t{addr}")
        if not found:
            print("no printers found")
    else:
        from tnp.print.catprinter import print_image
        from tnp.print.samples import sample_items

        img = render_receipt(sample_items()[:2], edition_date=datetime.now(), edition_name="Test Edition")
        asyncio.run(print_image(img, args.address))
        print("sent")


if __name__ == "__main__":
    main()
