"""
Downloads the official Nifty 50 / 100 / 500 constituent lists and converts
them into flat JSON files the static frontend can fetch directly.
"""
import os
import csv
import json
import io
import urllib.request

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")

SOURCES = {
    "nifty50": "https://www.niftyindices.com/IndexConstituent/ind_nifty50list.csv",
    "nifty100": "https://www.niftyindices.com/IndexConstituent/ind_nifty100list.csv",
    "nifty500": "https://www.niftyindices.com/IndexConstituent/ind_nifty500list.csv",
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}


def _fetch_csv_text(url: str) -> str:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as res:
        return res.read().decode("utf-8", errors="replace")


def download_all(force: bool = False):
    os.makedirs(DATA_DIR, exist_ok=True)
    universes = {}

    for universe, url in SOURCES.items():
        out_path = os.path.join(DATA_DIR, f"{universe}.json")
        try:
            csv_text = _fetch_csv_text(url)
            reader = csv.DictReader(io.StringIO(csv_text))
            rows = []
            for row in reader:
                symbol = (row.get("Symbol") or "").strip()
                if not symbol or symbol == "Symbol":
                    continue
                rows.append({
                    "symbol": symbol,
                    "ticker": f"{symbol}.NS",
                    "company_name": (row.get("Company Name") or symbol).strip(),
                    "industry": (row.get("Industry") or "N/A").strip(),
                    "series": (row.get("Series") or "EQ").strip(),
                    "isin": (row.get("ISIN Code") or "").strip(),
                })
            with open(out_path, "w") as f:
                json.dump(rows, f, indent=2)
            universes[universe] = rows
            print(f"[nifty_lists] {universe}: {len(rows)} constituents saved -> {out_path}")
        except Exception as e:
            print(f"[nifty_lists] FAILED to refresh {universe}: {e}")
            # Fall back to whatever is already on disk so the pipeline can continue
            if os.path.exists(out_path):
                with open(out_path) as f:
                    universes[universe] = json.load(f)
            else:
                universes[universe] = []

    return universes


if __name__ == "__main__":
    download_all()
