"""
Server-side Screener.in scraper. Runs inside GitHub Actions (not the browser),
so there are no CORS restrictions. Output feeds /data/fundamentals.json.
"""
import re
import urllib.request

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}


def scrape_screener_direct(symbol):
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        print("[screener_scrape] BeautifulSoup4 not installed.")
        return None

    slug = symbol.replace(".NS", "").replace(".BO", "").upper()
    url = f"https://www.screener.in/company/{slug}/"
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            html = response.read()
    except Exception as e:
        print(f"[screener_scrape] fetch failed for {slug}: {e}")
        return None

    soup = BeautifulSoup(html, "html.parser")
    sections = {"quarters": "quarters", "pnl": "profit-loss", "shareholding": "shareholding"}
    parsed = {"quarters": {}, "pnl": {}, "shareholding": {}, "ratios": {}}

    ratios_ul = soup.find("ul", id="top-ratios")
    if ratios_ul:
        for li in ratios_ul.find_all("li"):
            name_span = li.find("span", class_="name")
            value_span = li.find("span", class_="value")
            if not (name_span and value_span):
                continue
            name = name_span.get_text().strip().lower()
            num_span = value_span.find("span", class_="number")
            val_str = num_span.get_text().strip() if num_span else value_span.get_text().strip()
            val_str = val_str.replace(",", "").replace("₹", "").replace("%", "").strip()
            try:
                val = float(val_str)
            except ValueError:
                continue
            if "market cap" in name:
                parsed["ratios"]["market_cap"] = val
            elif "current price" in name:
                parsed["ratios"]["current_price"] = val
            elif "roe" in name and "roce" not in name:
                parsed["ratios"]["roe"] = val

    for key, sect_id in sections.items():
        section = soup.find("section", id=sect_id)
        if not section:
            continue
        table = section.find("table")
        if not table:
            continue

        thead = table.find("thead")
        headers_list = []
        if thead:
            headers_list = [th.get_text().strip() for th in thead.find_all("th") if th.get_text().strip()]
            if headers_list and (headers_list[0].lower().startswith(("quarter", "sector", "year")) or headers_list[0] == ""):
                headers_list = headers_list[1:]
            parsed[key]["headers"] = headers_list

        tbody = table.find("tbody")
        if not tbody:
            continue
        for row in tbody.find_all("tr"):
            cols = row.find_all("td")
            if not cols:
                continue
            label = re.sub(r"\s*\+$", "", cols[0].get_text().strip().lower()).replace("in rs", "").strip()
            mapped_key = None
            if key in ("quarters", "pnl"):
                if "sales" in label or "revenue" in label:
                    mapped_key = "sales"
                elif "expenses" in label:
                    mapped_key = "expenses"
                elif "operating profit" in label:
                    mapped_key = "operating_profit"
                elif "opm" in label:
                    mapped_key = "opm_percent"
                elif "net profit" in label:
                    mapped_key = "net_profit"
                elif "eps" in label:
                    mapped_key = "eps"
            elif key == "shareholding":
                if "promoter" in label:
                    mapped_key = "promoters"
                elif "fii" in label:
                    mapped_key = "fiis"
                elif "dii" in label:
                    mapped_key = "diis"
                elif "public" in label:
                    mapped_key = "public"
                elif "government" in label:
                    mapped_key = "government"
            if not mapped_key:
                continue
            values = []
            for col in cols[1:]:
                val_text = col.get_text().strip().replace(",", "").replace("%", "")
                values.append(0.0 if val_text in ("-", "") else _safe_float(val_text))
            parsed[key][mapped_key] = [v for v in values if v is not None]

    return parsed


def _safe_float(text):
    try:
        return float(text)
    except ValueError:
        return None
