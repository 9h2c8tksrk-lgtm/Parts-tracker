"""Import master_parts_list.json into the Supabase `parts` table.

Existing barcodes are left untouched, so stock levels and manual edits are kept.

Usage:
  SUPABASE_URL=https://YOUR-PROJECT.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=... \
  python3 scripts/import_parts.py

The service role key bypasses RLS: keep it in your shell only, never in config.js or git.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

SOURCE = Path(__file__).resolve().parent.parent / "master_parts_list.json"
BATCH_SIZE = 500


def main():
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.")

    rows = [
        {
            "barcode": p["Barcode"],
            "part_name": p["PartName"],
            "description": p["Description"],
            "stock_level": p["StockLevel"],
        }
        for p in json.loads(SOURCE.read_text())
    ]

    for start in range(0, len(rows), BATCH_SIZE):
        batch = rows[start:start + BATCH_SIZE]
        request = urllib.request.Request(
            f"{url}/rest/v1/parts?on_conflict=barcode",
            data=json.dumps(batch).encode(),
            method="POST",
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "Prefer": "resolution=ignore-duplicates,return=minimal",
            },
        )
        try:
            urllib.request.urlopen(request).close()
        except urllib.error.HTTPError as error:
            sys.exit(f"Batch at row {start} failed: {error.code} {error.read().decode()}")
        print(f"Imported {min(start + BATCH_SIZE, len(rows))}/{len(rows)}")


if __name__ == "__main__":
    main()
