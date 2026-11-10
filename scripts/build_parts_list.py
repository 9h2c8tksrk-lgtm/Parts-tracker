"""Convert 'Item Reference List.csv.xlsx' into master_parts_list.json.

Usage: python3 scripts/build_parts_list.py [--max-length 14]
Requires: pandas, openpyxl
"""
import argparse
import json
from datetime import datetime
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "Item Reference List.csv.xlsx"
TARGET = ROOT / "master_parts_list.json"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-length", type=int, default=14, help="matches maximumBarcodeLength in app.js")
    max_length = parser.parse_args().max_length

    df = pd.read_excel(SOURCE, sheet_name=0, dtype=str)
    df = df.apply(lambda col: col.str.strip() if col.dtype == object else col)

    today = pd.Timestamp(datetime.now().date())
    ended = pd.to_datetime(df["Ending Date"], errors="coerce").le(today)
    df = df[~ended & (df["Reference No."] != "DISCONTINUED")]

    # Best description per item, used when a reference row has none.
    item_desc = (
        df.dropna(subset=["Description"]).groupby("Item No.")["Description"].first().to_dict()
    )

    # Existing entries (e.g. stock levels) take priority over the spreadsheet.
    existing = json.loads(TARGET.read_text()) if TARGET.exists() else []
    result = {p["Barcode"]: p for p in existing}

    df = df.assign(
        _zz=df["Item No."].str.startswith("ZZ"),
        _bar=df["Reference Type"].ne("Bar Code"),
    ).sort_values(["_zz", "_bar"], kind="stable")  # prefer live items, then bar codes

    for _, row in df.iterrows():
        item = row["Item No."]
        description = row["Description"] if isinstance(row["Description"], str) else item_desc.get(item, "")
        # Item numbers are scannable too, so index them alongside references.
        for code in (row["Reference No."], item):
            if not code or len(code) > max_length or code in result:
                continue
            result[code] = {
                "Barcode": code,
                "PartName": item,
                "Description": description,
                "StockLevel": 0,
            }

    TARGET.write_text(json.dumps(list(result.values()), indent=2, ensure_ascii=False) + "\n")
    print(f"Wrote {len(result)} parts to {TARGET.name}")


if __name__ == "__main__":
    main()
