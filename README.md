# IndiSmith | NSE/BSE CAN SLIM® Terminal

A premium, **fully static** CAN SLIM® growth-investing dashboard for Indian
equities (NSE/BSE). It runs entirely in the browser — no server, no Python
process to keep alive — and is designed to be hosted for free on **GitHub
Pages**.

> CAN SLIM® is a trademark of Investor's Business Daily / William O'Neil +
> Co. This is an independent, unaffiliated research tool that automates the
> public CAN SLIM methodology against Indian market data.

## How it works

Live web scraping (Yahoo Finance technicals, Screener.in fundamentals) can't
run from a static page — browsers block those cross-origin requests. So the
heavy lifting happens on a schedule, server-side, in **GitHub Actions**:

```
┌─────────────────────────┐        nightly / on-demand        ┌──────────────────┐
│ .github/workflows/       │ ───────────────────────────────▶ │  data/*.json      │
│ update-data.yml           │   scripts/build_data.py           │  (committed to    │
│ (runs the Python scraper) │   • Nifty 50/100/500 lists        │   the repo)       │
└─────────────────────────┘   • Yahoo technicals + RS ranks    └──────────────────┘
                               • Screener.in fundamentals                │
                                                                          ▼
                                                          ┌───────────────────────────┐
                                                          │ index.html / app.js /     │
                                                          │ assets/canslim.js         │
                                                          │ (GitHub Pages, static)    │
                                                          │  scores every stock live  │
                                                          │  in the visitor's browser │
                                                          └───────────────────────────┘
```

The CAN SLIM scoring math (`scripts/*.py` originally, now also ported to
`assets/canslim.js`) runs **client-side**, so pasting fresh Screener.in text
recalculates a stock's score instantly with no round trip anywhere.

## 🚀 Deploy it (GitHub Pages)

1. Create a new GitHub repository and push this folder to it:
   ```bash
   git init
   git add .
   git commit -m "Initial commit: IndiSmith CAN SLIM terminal"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. In the repo: **Settings → Pages → Source → Deploy from a branch**, pick
   `main` / `/ (root)`, save.
3. In the repo: **Settings → Actions → General → Workflow permissions**, select
   **"Read and write permissions"** (the data-refresh workflow needs to commit
   updated JSON files back to the repo).
4. Go to the **Actions** tab → **Refresh CAN SLIM Data** → **Run workflow**
   once manually. This populates real Nifty constituent lists, technicals,
   RS ratings, market direction, and Screener.in fundamentals (takes a few
   minutes; longer the first time for the fundamentals scrape).
5. Visit `https://<you>.github.io/<repo>/` — your dashboard is live.

The workflow also runs automatically **Mon–Fri, ~1 hour after NSE close**
(cron `0 11 * * 1-5` UTC = 4:30pm IST), keeping technicals, RS ratings, and
market direction fresh. You can widen or narrow the universes and scrape
frequency by editing `.github/workflows/update-data.yml`.

**Note on the bundled seed data:** this repo ships with `data/*.json` already
populated from a prior local run so the site isn't empty on first load, but
the Nifty 50/100 vs 500 tiering is a placeholder (all fields present, sector
tagging just isn't segmented yet). Running the workflow once replaces it with
the real, correctly-tiered NSE constituent lists.

## 🧪 Local development

No build step — it's plain HTML/CSS/JS. To avoid `fetch()` CORS issues with
`file://` URLs, serve it locally:

```bash
python3 -m http.server 8090
# then open http://127.0.0.1:8090
```

To run the data pipeline locally instead of waiting for Actions:

```bash
pip install -r scripts/requirements.txt
python scripts/build_data.py --universe nifty100 --fundamentals-universe nifty50
```

## 📂 Codebase map

```
indismith/
├── index.html                 <- static page shell
├── style.css                  <- ledger/terminal theme
├── app.js                     <- UI wiring, data loading, chart rendering
├── assets/
│   └── canslim.js              <- client-side CAN SLIM scoring engine (JS port)
├── data/                       <- static JSON, refreshed by GitHub Actions
│   ├── nifty50.json / nifty100.json / nifty500.json
│   ├── technicals.json         <- price, EMA, volume, RS rating per ticker
│   ├── fundamentals.json       <- Screener.in quarterly/annual/shareholding data
│   ├── market_direction.json   <- Nifty 'M' status
│   └── meta.json                <- last build timestamp, universe sizes
├── scripts/                     <- Python data pipeline (Actions-only, not shipped to browser)
│   ├── nifty_lists.py
│   ├── yahoo_engine.py
│   ├── screener_scrape.py
│   ├── build_data.py            <- orchestrator entrypoint
│   └── requirements.txt
└── .github/workflows/
    └── update-data.yml          <- scheduled + manual data refresh
```

## ✨ Features

* **Ledger-style CAN SLIM scorecard** — C·A·N·S·L·I·M broken into a stamped
  verdict seal (STRONG BUY / WATCHLIST / AVOID) with full pass/fail reasoning
  per letter.
* **RS Engine** — IBD-style weighted quarterly return, percentile-ranked
  1–99 across the chosen universe.
* **Market Pulse ticker tape** — scrolling RS leaders across Nifty 100.
* **Sector Scanner** — Leaders (80+) / Watchlist (60–79) / Avoid (<60),
  filterable by industry.
* **Screener.in paste-to-recalculate** — client-side parser, no backend.
* **AI Analyst Thesis** — one-click prompt copy for Claude/Gemini deep dives.
* **Price & Volume chart** — Chart.js, 50/200 EMA overlay, up/down volume.
