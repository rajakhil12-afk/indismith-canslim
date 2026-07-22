"""
Orchestrator run on a schedule by .github/workflows/update-data.yml.

Produces (all under /data, committed as static assets for GitHub Pages):
  nifty50.json / nifty100.json / nifty500.json   - constituent lists
  market_direction.json                          - Nifty 'M' status
  technicals.json                                - per-ticker price/RS/EMA/volume data
  fundamentals.json                              - per-symbol Screener.in fundamentals
  meta.json                                      - build metadata / freshness

Usage:
    python scripts/build_data.py --universe nifty500 --fundamentals-universe nifty200 --max-age-days 3
"""
import os
import sys
import json
import time
import argparse
import datetime

sys.path.insert(0, os.path.dirname(__file__))

import nifty_lists
import yahoo_engine
import screener_scrape

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")


def load_json(name, default):
    path = os.path.join(DATA_DIR, name)
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            return default
    return default


def save_json(name, obj):
    os.makedirs(DATA_DIR, exist_ok=True)
    path = os.path.join(DATA_DIR, name)
    with open(path, "w") as f:
        json.dump(obj, f, indent=2)
    print(f"[build_data] wrote {path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--universe", default="nifty500",
                         help="Universe used for RS ranking + constituent lists")
    parser.add_argument("--fundamentals-universe", default="nifty100",
                         help="Smaller universe for the (slower/rate-limited) Screener.in fundamentals scrape")
    parser.add_argument("--max-age-days", type=int, default=3,
                         help="Skip re-scraping fundamentals fresher than this many days")
    parser.add_argument("--scrape-delay", type=float, default=1.2,
                         help="Delay between Screener.in requests (seconds), be a good citizen")
    parser.add_argument("--skip-fundamentals", action="store_true")
    args = parser.parse_args()

    print("=== [1/4] Refreshing Nifty constituent lists ===")
    universes = nifty_lists.download_all()

    all_tickers = [row["ticker"] for row in universes.get(args.universe, [])]
    if not all_tickers:
        print(f"[build_data] WARNING: universe '{args.universe}' is empty, falling back to nifty100")
        all_tickers = [row["ticker"] for row in universes.get("nifty100", [])]

    print(f"=== [2/4] Market direction (Nifty 50 index) ===")
    market_direction = yahoo_engine.analyze_market_direction()
    save_json("market_direction.json", market_direction)

    print(f"=== [3/4] Technicals + RS ratings for {len(all_tickers)} tickers ===")
    rs_ratings = yahoo_engine.build_technicals(all_tickers)

    technicals_cache = load_json("technicals.json", {})
    fetched, failed = 0, 0
    for ticker in all_tickers:
        rs_info = rs_ratings.get(ticker, {"rs_rating": 50, "rs_score": 0.0})
        result = yahoo_engine.build_full_technicals_for_ticker(ticker, rs_info)
        if result:
            technicals_cache[ticker] = result
            fetched += 1
        else:
            failed += 1
        time.sleep(0.5)  # avoid Yahoo rate limiting across large universes
        if fetched % 25 == 0:
            print(f"  ...{fetched} tickers processed")
    print(f"[build_data] technicals fetched={fetched} failed={failed}")
    save_json("technicals.json", technicals_cache)

    if not args.skip_fundamentals:
        print(f"=== [4/4] Screener.in fundamentals for '{args.fundamentals_universe}' ===")
        fundamentals_cache = load_json("fundamentals.json", {})
        fund_symbols = [row["symbol"] for row in universes.get(args.fundamentals_universe, [])]
        now = datetime.datetime.utcnow()
        scraped, skipped, fund_failed = 0, 0, 0

        for symbol in fund_symbols:
            existing = fundamentals_cache.get(symbol.upper())
            if existing and existing.get("_scraped_at"):
                try:
                    age = now - datetime.datetime.fromisoformat(existing["_scraped_at"].replace("Z", ""))
                    if age.days < args.max_age_days:
                        skipped += 1
                        continue
                except Exception:
                    pass

            data = screener_scrape.scrape_screener_direct(symbol)
            if data and data.get("quarters"):
                data["_scraped_at"] = now.isoformat() + "Z"
                fundamentals_cache[symbol.upper()] = data
                scraped += 1
            else:
                fund_failed += 1
            time.sleep(args.scrape_delay)

        print(f"[build_data] fundamentals scraped={scraped} skipped(fresh)={skipped} failed={fund_failed}")
        save_json("fundamentals.json", fundamentals_cache)
    else:
        print("=== [4/4] Skipped fundamentals scrape (--skip-fundamentals) ===")

    save_json("meta.json", {
        "last_build": datetime.datetime.utcnow().isoformat() + "Z",
        "universe": args.universe,
        "fundamentals_universe": args.fundamentals_universe,
        "ticker_count": len(all_tickers),
    })
    print("=== Done ===")


if __name__ == "__main__":
    main()
