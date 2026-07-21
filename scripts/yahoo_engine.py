"""
Technicals + Relative Strength (RS) + Market Direction (M) engine.
Runs server-side inside GitHub Actions (no browser CORS restrictions apply here).
Output is written to /data/technicals.json and /data/market_direction.json,
which the static frontend consumes directly.
"""
import os
import json
import time
import datetime
import urllib.request
import urllib.parse

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}


def calculate_ema(prices, period):
    if len(prices) < period:
        return [None] * len(prices)
    k = 2 / (period + 1)
    ema = [None] * len(prices)
    ema[period - 1] = sum(prices[:period]) / period
    for i in range(period, len(prices)):
        ema[i] = (prices[i] * k) + (ema[i - 1] * (1 - k))
    return ema


def calculate_weighted_rs_score(prices):
    """IBD-style weighted 12-month return: 40% most recent quarter, 20% each prior quarter."""
    prices = [p for p in prices if p is not None]
    n = len(prices)
    if n < 252:
        if n >= 63:
            return ((prices[-1] / prices[-63] - 1) * 100) * 0.4
        return -99.0
    p_now, p_3m, p_6m, p_9m, p_12m = prices[-1], prices[-63], prices[-126], prices[-189], prices[-252]
    r_q1 = (p_now / p_3m - 1) * 100
    r_q2 = (p_3m / p_6m - 1) * 100
    r_q3 = (p_6m / p_9m - 1) * 100
    r_q4 = (p_9m / p_12m - 1) * 100
    return (0.4 * r_q1) + (0.2 * r_q2) + (0.2 * r_q3) + (0.2 * r_q4)


def fetch_history(ticker, range_str="1y"):
    """Returns (closes, volumes, candles[])"""
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(ticker)}"
           f"?range={range_str}&interval=1d")
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            data = json.loads(res.read())
        result = data.get("chart", {}).get("result", [])
        if not result:
            return [], [], []
        block = result[0]
        timestamps = block.get("timestamp", [])
        quote = block.get("indicators", {}).get("quote", [{}])[0]
        opens, highs, lows, closes, volumes = (quote.get(k, []) for k in
                                                 ("open", "high", "low", "close", "volume"))
        clean_closes, clean_vols, candles = [], [], []
        for i, ts in enumerate(timestamps):
            c = closes[i] if i < len(closes) else None
            if c is None:
                continue
            v = volumes[i] if i < len(volumes) and volumes[i] is not None else 0
            clean_closes.append(c)
            clean_vols.append(v)
            candles.append({
                "date": datetime.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d"),
                "open": round(opens[i], 2) if i < len(opens) and opens[i] is not None else round(c, 2),
                "high": round(highs[i], 2) if i < len(highs) and highs[i] is not None else round(c, 2),
                "low": round(lows[i], 2) if i < len(lows) and lows[i] is not None else round(c, 2),
                "close": round(c, 2),
                "volume": int(v),
            })
        return clean_closes, clean_vols, candles
    except Exception as e:
        print(f"[yahoo_engine] history fetch failed for {ticker}: {e}")
        return [], [], []


def fetch_quote_summary(ticker):
    url = (f"https://query1.finance.yahoo.com/v10/finance/quoteSummary/{urllib.parse.quote(ticker)}"
           f"?modules=summaryDetail,defaultKeyStatistics,financialData")
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            data = json.loads(res.read())
        result = data.get("quoteSummary", {}).get("result", [])
        if not result:
            return {}
        r = result[0]
        return {
            "marketCap": r.get("summaryDetail", {}).get("marketCap", {}).get("raw", 0),
            "sharesOutstanding": r.get("defaultKeyStatistics", {}).get("sharesOutstanding", {}).get("raw", 0),
            "returnOnEquity": (r.get("financialData", {}).get("returnOnEquity", {}).get("raw", 0.0) or 0.0) * 100,
        }
    except Exception as e:
        print(f"[yahoo_engine] quoteSummary failed for {ticker}: {e}")
        return {}


def analyze_market_direction():
    closes, volumes, _ = fetch_history("^NSEI", "1y")
    if len(closes) < 50:
        return {"status": "Confirmed Uptrend", "distribution_days": 0,
                 "detail": "Insufficient index history", "score": 10,
                 "nifty_price": None, "nifty_50_ema": None, "nifty_200_ema": None}

    ema_50, ema_200 = calculate_ema(closes, 50), calculate_ema(closes, 200)
    curr_price, curr_ema_50, curr_ema_200 = closes[-1], ema_50[-1], ema_200[-1]

    recent_closes, recent_volumes = closes[-26:], volumes[-26:]
    dist_days = 0
    for i in range(1, len(recent_closes)):
        pct = (recent_closes[i] / recent_closes[i - 1] - 1) * 100
        if pct <= -0.2 and recent_volumes[i] > recent_volumes[i - 1]:
            dist_days += 1

    if curr_ema_200 is not None and curr_price < curr_ema_200:
        status, score = "Market in Correction", 2
        detail = f"Nifty 50 ({curr_price:.2f}) is trading below its 200-day EMA ({curr_ema_200:.2f}). Severe distribution/bearish conditions."
    elif dist_days >= 7:
        status, score = "Market in Correction", 3
        detail = f"High number of distribution days ({dist_days}) in the last 25 days indicates heavy institutional selling."
    elif dist_days >= 5:
        status, score = "Uptrend Under Pressure", 6
        detail = f"Nifty is in an uptrend, but facing pressure with {dist_days} distribution days. Exercise caution on new purchases."
    elif curr_ema_50 is not None and curr_ema_200 is not None and curr_ema_50 < curr_ema_200:
        status, score = "Uptrend Under Pressure", 5
        detail = "The 50-day EMA is below the 200-day EMA, showing long-term trend weakness."
    else:
        status, score = "Confirmed Uptrend", 10
        detail = f"Nifty is in a healthy uptrend with only {dist_days} distribution days."

    return {
        "status": status,
        "distribution_days": dist_days,
        "score": score,
        "detail": detail,
        "nifty_price": round(curr_price, 2),
        "nifty_50_ema": round(curr_ema_50, 2) if curr_ema_50 is not None else None,
        "nifty_200_ema": round(curr_ema_200, 2) if curr_ema_200 is not None else None,
        "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
    }


def build_technicals(tickers, chunk_size=20, sleep_between_chunks=0.4):
    """
    Uses the Yahoo 'spark' endpoint (cheap, batched) to compute RS ranks for the whole
    universe, then does a heavier per-ticker chart+quoteSummary fetch to get full
    technicals (EMA, volume ratio, float, price history for charting).
    """
    all_tickers = list(dict.fromkeys(tickers))
    scores = {}

    for i in range(0, len(all_tickers), chunk_size):
        chunk = all_tickers[i:i + chunk_size]
        encoded = [urllib.parse.quote(s) for s in chunk]
        url = f"https://query1.finance.yahoo.com/v7/finance/spark?symbols={','.join(encoded)}&range=1y&interval=1d"
        req = urllib.request.Request(url, headers=HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=20) as res:
                data = json.loads(res.read())
            for r in data.get("spark", {}).get("result", []):
                symbol = r.get("symbol")
                resp = r.get("response", [])
                if not resp:
                    continue
                quotes = resp[0].get("indicators", {}).get("quote", [])
                if not quotes:
                    continue
                closes = [p for p in quotes[0].get("close", []) if p is not None]
                if len(closes) < 63:
                    continue
                scores[symbol] = calculate_weighted_rs_score(closes)
        except Exception as e:
            print(f"[yahoo_engine] spark chunk failed ({chunk[0]}...): {e}")
        time.sleep(sleep_between_chunks)

    sorted_syms = sorted(scores.keys(), key=lambda s: scores[s])
    n = len(sorted_syms)
    rs_ratings = {}
    for idx, sym in enumerate(sorted_syms):
        pct = int(round((idx / (n - 1 if n > 1 else 1)) * 98 + 1))
        rs_ratings[sym] = {"rs_score": round(scores[sym], 2), "rs_rating": pct}

    return rs_ratings


def build_full_technicals_for_ticker(ticker, rs_info):
    closes, volumes, candles = fetch_history(ticker, "1y")
    if not closes:
        return None

    curr_price = closes[-1]
    fifty_two_week_high = max(closes)
    ema_50 = calculate_ema(closes, 50)
    ema_200 = calculate_ema(closes, 200)
    above_50 = ema_50[-1] is not None and curr_price > ema_50[-1]
    above_200 = ema_200[-1] is not None and curr_price > ema_200[-1]

    last_20 = volumes[-20:]
    avg_20_vol = sum(last_20) / len(last_20) if last_20 else 0
    volume_ratio = (volumes[-1] / avg_20_vol) if avg_20_vol > 0 else 1.0

    summary = fetch_quote_summary(ticker)
    market_cap = summary.get("marketCap", 0) or 0
    shares_out = summary.get("sharesOutstanding", 0) or 0
    roe = summary.get("returnOnEquity", 0.0) or 0.0

    return {
        "ticker": ticker,
        "current_price": round(curr_price, 2),
        "fifty_two_week_high": round(fifty_two_week_high, 2),
        "ema_50": round(ema_50[-1], 2) if ema_50[-1] is not None else None,
        "ema_200": round(ema_200[-1], 2) if ema_200[-1] is not None else None,
        "above_50_ema": above_50,
        "above_200_ema": above_200,
        "volume_ratio": round(volume_ratio, 2),
        "market_cap_crores": round(market_cap / 1e7, 2) if market_cap else 0,
        "shares_outstanding": shares_out,
        "yahoo_roe": round(roe, 1),
        "rs_rating": rs_info.get("rs_rating", 50),
        "rs_score": rs_info.get("rs_score", 0.0),
        # Downsample price history for chart payload size (weekly-ish granularity for older data)
        "price_history": candles[-260:],
        "updated_at": datetime.datetime.utcnow().isoformat() + "Z",
    }
