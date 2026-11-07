"""Cat-printer BLE protocol (clean reimplementation of https://github.com/rbaron/catprinter, MIT)."""
from tnp.print.catprinter.ble import PrinterError, PrinterNotFound, print_image, scan
from tnp.print.catprinter.protocol import (
    PRINT_WIDTH,
    crc8,
    encode_image,
    encode_print_job,
    frame,
    image_to_rows,
)

__all__ = [
    "PRINT_WIDTH", "PrinterError", "PrinterNotFound", "crc8", "encode_image",
    "encode_print_job", "frame", "image_to_rows", "print_image", "scan",
]
