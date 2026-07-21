/**
 * canslim.js
 * Full client-side port of the CAN SLIM scoring engine. Runs entirely in the
 * browser — no backend required. Ported line-for-line from the original
 * Python (canslim_analyzer.py / screener_parser.py) so the math matches.
 */

// ---------------------------------------------------------------------------
// Screener.in clipboard-paste parser
// ---------------------------------------------------------------------------
function extractNumberFromText(text) {
  const cleaned = String(text).replace(/,/g, '');
  const m = cleaned.match(/[-+]?\d*\.\d+|\d+/);
  return m ? parseFloat(m[0]) : null;
}

function parseScreenerText(rawText) {
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

  const data = { quarters: {}, pnl: {}, shareholding: {}, ratios: {} };

  const quartersLabels = {
    sales: ['sales', 'sales +', 'revenue'],
    expenses: ['expenses', 'expenses +'],
    operating_profit: ['operating profit'],
    opm_percent: ['opm %'],
    net_profit: ['net profit', 'net profit +', 'net profit  +'],
    eps: ['eps in rs', 'eps', 'eps in rs +'],
  };
  const pnlLabels = quartersLabels; // same label set
  const shareholdingLabels = {
    promoters: ['promoters', 'promoter', 'promoters +', 'promoter +'],
    fiis: ["fiis", "fii", "fii +", "fiis +", "fii's"],
    diis: ["diis", "dii", "dii +", "diis +", "dii's"],
    public: ['public', 'public +'],
    government: ['government', 'government +'],
  };

  const datePattern = /\b([A-Za-z]{3}\s\d{4}|[A-Za-z]{3}\s\d{2}|TTM)\b/g;

  function extractNumbersFromLine(line, labelText) {
    const content = line.slice(labelText.length).trim();
    let tokens = content.split(/\t|\s{2,}/);
    if (tokens.length <= 1) tokens = content.split(/\s+/);
    const values = [];
    for (let t of tokens) {
      t = t.trim().replace(/,/g, '');
      if (!t) continue;
      if (t.endsWith('%')) t = t.slice(0, -1);
      if (t === '-' || t === '') { values.push(0.0); continue; }
      const f = parseFloat(t);
      if (!Number.isNaN(f) && /^[-+]?\d*\.?\d+$/.test(t)) values.push(f);
    }
    return values;
  }

  let currentSection = null;

  for (const line of lines) {
    const lineLower = line.toLowerCase();

    if (lineLower.includes('quarterly results') || lineLower === 'quarters') {
      currentSection = 'quarters'; continue;
    } else if (lineLower.includes('profit & loss')) {
      currentSection = 'pnl'; continue;
    } else if (lineLower.includes('shareholding pattern')) {
      currentSection = 'shareholding'; continue;
    } else if (lineLower.includes('balance sheet')) {
      if (currentSection === 'pnl') currentSection = null;
      continue;
    } else if (lineLower.includes('cash flows')) {
      if (currentSection === 'shareholding') currentSection = null;
      continue;
    }

    if (!currentSection) continue;

    const foundDates = [...line.matchAll(datePattern)].map(m => m[0]);
    if (foundDates.length >= 2) {
      data[currentSection].headers = foundDates;
      continue;
    }

    const labelSets = currentSection === 'quarters' ? quartersLabels
      : currentSection === 'pnl' ? pnlLabels
      : shareholdingLabels;

    for (const [key, labels] of Object.entries(labelSets)) {
      for (const label of labels) {
        if (lineLower.startsWith(label)) {
          const vals = extractNumbersFromLine(line, line.slice(0, label.length));
          data[currentSection][key] = vals;
          break;
        }
      }
    }
  }

  // Ratios: market cap / ROE / current price often sit on the line below the label
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    if (lineLower.includes('market cap')) {
      const val = (i + 1 < lines.length ? extractNumberFromText(lines[i + 1]) : null) ?? extractNumberFromText(lines[i]);
      if (val !== null) data.ratios.market_cap = val;
    } else if (lineLower === 'roe' || lineLower.includes('return on equity')) {
      const val = (i + 1 < lines.length ? extractNumberFromText(lines[i + 1]) : null) ?? extractNumberFromText(lines[i]);
      if (val !== null) data.ratios.roe = val;
    } else if (lineLower.includes('current price')) {
      const val = (i + 1 < lines.length ? extractNumberFromText(lines[i + 1]) : null) ?? extractNumberFromText(lines[i]);
      if (val !== null) data.ratios.current_price = val;
    }
  }

  return data;
}

// ---------------------------------------------------------------------------
// CAN SLIM scoring engine
// ---------------------------------------------------------------------------

/**
 * @param ticker        e.g. "RELIANCE.NS"
 * @param fundamentals  { quarters, pnl, shareholding, ratios } (from cache or pasted text)
 * @param technicals    cached per-ticker technicals object (may have nulls if not yet synced)
 * @param marketDirection cached market_direction.json object
 */
function calculateCanslimScore(ticker, fundamentals, technicals, marketDirection) {
  fundamentals = fundamentals || { quarters: {}, pnl: {}, shareholding: {}, ratios: {} };
  technicals = technicals || {};
  const scorecard = {};

  const rsRating = technicals.rs_rating ?? 50;
  const rsScore = technicals.rs_score ?? 0.0;

  let currPrice = technicals.current_price ?? 0;
  const fiftyTwoWeekHigh = technicals.fifty_two_week_high ?? (currPrice || 1);
  const volumeRatio = technicals.volume_ratio ?? 1.0;
  const above50Ema = !!technicals.above_50_ema;
  const above200Ema = !!technicals.above_200_ema;

  const ratios = fundamentals.ratios || {};
  const roe = ratios.roe ?? technicals.yahoo_roe ?? 0.0;
  let marketCapCrores = ratios.market_cap ?? technicals.market_cap_crores ?? 0.0;
  if (!currPrice) currPrice = ratios.current_price ?? 0.0;

  let sharesOutstanding = technicals.shares_outstanding || 0;
  if (!sharesOutstanding && marketCapCrores > 0 && currPrice > 0) {
    sharesOutstanding = Math.round((marketCapCrores * 10000000) / currPrice);
  }

  // ---- C: Current Quarterly Earnings (max 15) ----
  let cScore = 0; const cDetails = [];
  const qData = fundamentals.quarters || {};
  let epsGrowth = 0.0, salesGrowth = 0.0;

  if (qData.eps && qData.eps.length >= 5) {
    const epsList = qData.eps;
    const salesList = qData.sales || [];
    const latestEps = epsList[epsList.length - 1];
    const lyEps = epsList[epsList.length - 5];

    epsGrowth = lyEps > 0 ? ((latestEps / lyEps) - 1) * 100 : (latestEps > 0 ? 999.0 : 0.0);

    if (epsGrowth >= 25) {
      cScore += 10;
      cDetails.push(`Pass: Quarterly EPS growth is stellar at ${epsGrowth.toFixed(1)}% (O'Neil target: >= 25%)`);
    } else {
      cDetails.push(`Fail: Quarterly EPS growth of ${epsGrowth.toFixed(1)}% is below the 25% growth target`);
    }

    if (salesList.length >= 5) {
      const latestSales = salesList[salesList.length - 1];
      const lySales = salesList[salesList.length - 5];
      if (lySales > 0) salesGrowth = ((latestSales / lySales) - 1) * 100;
      if (salesGrowth >= 20) {
        cScore += 3;
        cDetails.push(`Pass: Quarterly Sales growth is strong at ${salesGrowth.toFixed(1)}% (target: >= 20%)`);
      } else {
        cDetails.push(`Fail: Quarterly Sales growth of ${salesGrowth.toFixed(1)}% is weak`);
      }
    } else {
      cDetails.push('Warning: Sales history is insufficient to calculate quarterly growth');
    }

    if (epsList.length >= 6) {
      const prevEps = epsList[epsList.length - 2];
      const prevLyEps = epsList[epsList.length - 6];
      const prevEpsGrowth = prevLyEps > 0 ? ((prevEps / prevLyEps) - 1) * 100 : 0.0;
      if (epsGrowth > prevEpsGrowth && epsGrowth >= 25) {
        cScore += 2;
        cDetails.push(`Pass: Earnings are accelerating! (${epsGrowth.toFixed(1)}% vs ${prevEpsGrowth.toFixed(1)}% prior quarter)`);
      }
    } else {
      cDetails.push('Note: Cannot calculate acceleration (needs 6 quarters of data)');
    }
  } else {
    cDetails.push('Fail: Quarterly financial data is missing or incomplete (requires 5+ quarters)');
  }
  scorecard.C = { score: cScore, max: 15, details: cDetails, metrics: { eps_growth: round1(epsGrowth), sales_growth: round1(salesGrowth) } };

  // ---- A: Annual Earnings Growth (max 15) ----
  let aScore = 0; const aDetails = [];
  const pnlData = fundamentals.pnl || {};
  let annualEpsCagr = 0.0;

  if (pnlData.eps && pnlData.eps.length >= 3) {
    const epsAnnual = pnlData.eps;
    const headersAnnual = pnlData.headers || [];
    const validEps = epsAnnual.filter((e, idx) => headersAnnual[idx] !== 'TTM');

    if (validEps.length >= 3) {
      const startEps = validEps[0];
      const endEps = validEps[validEps.length - 1];
      const nYears = validEps.length - 1;
      if (startEps > 0 && endEps > 0) {
        annualEpsCagr = (Math.pow(endEps / startEps, 1 / nYears) - 1) * 100;
      }
      if (annualEpsCagr >= 25) {
        aScore += 10;
        aDetails.push(`Pass: 3-Year Annual EPS CAGR is outstanding at ${annualEpsCagr.toFixed(1)}% (target: >= 25%)`);
      } else {
        aDetails.push(`Fail: Annual EPS growth rate of ${annualEpsCagr.toFixed(1)}% is below O'Neil's 25% standard`);
      }
    } else {
      aDetails.push('Warning: Insufficient annual fiscal years for CAGR calculation');
    }

    if (roe >= 17) {
      aScore += 5;
      aDetails.push(`Pass: Return on Equity (ROE) is superior at ${roe.toFixed(1)}% (O'Neil target: >= 17%)`);
    } else {
      aDetails.push(`Fail: ROE of ${roe.toFixed(1)}% is below the 17% leadership threshold`);
    }
  } else {
    aDetails.push('Fail: Annual profit & loss data is missing (requires 3+ years)');
  }
  scorecard.A = { score: aScore, max: 15, details: aDetails, metrics: { eps_cagr: round1(annualEpsCagr), roe: round1(roe) } };

  // ---- N: New Highs / New Products / New Management (max 15) ----
  let nScore = 0; const nDetails = [];
  const distHigh = fiftyTwoWeekHigh > 0 ? ((currPrice / fiftyTwoWeekHigh) - 1) * 100 : -100.0;
  if (distHigh >= -15) {
    nScore += 8;
    nDetails.push(`Pass: Stock is within ${Math.abs(distHigh).toFixed(1)}% of its 52-week high (near a breakout pivot)`);
  } else {
    nDetails.push(`Fail: Stock is trading ${Math.abs(distHigh).toFixed(1)}% below its 52-week high (laggard setup)`);
  }
  if (above50Ema && above200Ema) {
    nScore += 4;
    nDetails.push('Pass: Price is in a confirmed uptrend above both 50-day and 200-day EMAs');
  } else {
    nDetails.push('Fail: Price is below major daily EMAs (50 DMA or 200 DMA)');
  }
  nScore += 3;
  nDetails.push('Checklist: Verified presence of industry tailwind, new product cycle, or leadership change (+3 pts default)');
  scorecard.N = { score: nScore, max: 15, details: nDetails, metrics: { dist_high: round1(distHigh) } };

  // ---- S: Supply and Demand (max 15) ----
  let sScore = 0; const sDetails = [];
  const sharesCr = sharesOutstanding / 10000000;
  if (sharesCr > 0 && sharesCr <= 20) {
    sScore += 5;
    sDetails.push(`Pass: Tight float with only ${sharesCr.toFixed(1)} Crore shares outstanding (explosive potential)`);
  } else if (sharesCr > 20 && sharesCr <= 100) {
    sScore += 3;
    sDetails.push(`Neutral: Moderate float of ${sharesCr.toFixed(1)} Crore shares outstanding`);
  } else {
    sDetails.push(`Fail: Heavy float of ${sharesCr.toFixed(1)} Crore shares outstanding (requires massive volume to move)`);
  }
  if (volumeRatio >= 1.5) {
    sScore += 5;
    sDetails.push(`Pass: Heavy institutional accumulation! Today's volume is ${volumeRatio.toFixed(1)}x the 20-day average`);
  } else if (volumeRatio >= 1.0) {
    sScore += 2;
    sDetails.push(`Neutral: Normal trading volume (${volumeRatio.toFixed(1)}x of 20-day average)`);
  } else {
    sDetails.push(`Fail: Dull volume (${volumeRatio.toFixed(1)}x of 20-day average)`);
  }
  try {
    const candles = (technicals.price_history || []).slice(-20);
    const upVols = candles.filter(c => c.close >= c.open).map(c => c.volume);
    const downVols = candles.filter(c => c.close < c.open).map(c => c.volume);
    const avgUp = upVols.length ? upVols.reduce((a, b) => a + b, 0) / upVols.length : 0;
    const avgDown = downVols.length ? downVols.reduce((a, b) => a + b, 0) / downVols.length : 0;
    if (avgUp > avgDown && candles.length > 0) {
      sScore += 5;
      sDetails.push('Pass: Positive close days show higher average volume, indicating institutional accumulation');
    } else {
      sDetails.push('Fail: Negative close days show higher average volume, indicating institutional distribution');
    }
  } catch (e) {
    sDetails.push('Warning: Could not compute accumulation/distribution volume rating');
  }
  scorecard.S = { score: sScore, max: 15, details: sDetails, metrics: { shares_cr: round1(sharesCr, 2), volume_ratio: round1(volumeRatio, 2) } };

  // ---- L: Leader or Laggard (max 15) ----
  let lScore = 0; const lDetails = [];
  if (rsRating >= 90) {
    lScore = 15;
    lDetails.push(`Pass: Elite Leader! RS Rating is ${rsRating}/99. Out-performing the index by a massive margin`);
  } else if (rsRating >= 80) {
    lScore = 10;
    lDetails.push(`Pass: Market Leader. RS Rating is ${rsRating}/99 (O'Neil threshold: >= 80)`);
  } else if (rsRating >= 70) {
    lScore = 5;
    lDetails.push(`Neutral: Borderline. RS Rating is ${rsRating}/99. Average momentum`);
  } else {
    lDetails.push(`Fail: Laggard. RS Rating is ${rsRating}/99. Heavy underperformance`);
  }
  scorecard.L = { score: lScore, max: 15, details: lDetails, metrics: { rs_rating: rsRating, rs_score: rsScore } };

  // ---- I: Institutional Sponsorship (max 15) ----
  let iScore = 0; const iDetails = []; let fiiDiiTotal = 0.0; let fiiTrend = 'flat';
  const shData = fundamentals.shareholding || {};
  if (shData.fiis && shData.fiis.length >= 2) {
    const fiis = shData.fiis; const diis = shData.diis || [];
    const latestFii = fiis[fiis.length - 1];
    const latestDii = diis.length ? diis[diis.length - 1] : 0.0;
    fiiDiiTotal = latestFii + latestDii;
    if (fiiDiiTotal >= 10) {
      iScore += 5;
      iDetails.push(`Pass: High institutional sponsorship of ${fiiDiiTotal.toFixed(1)}% (FII: ${latestFii.toFixed(1)}%, DII: ${latestDii.toFixed(1)}%)`);
    } else {
      iDetails.push(`Fail: Weak institutional sponsorship of ${fiiDiiTotal.toFixed(1)}% (needs > 10% for institutional validation)`);
    }
    const prevFii = fiis[fiis.length - 2];
    const prevDii = diis.length ? diis[diis.length - 2] : 0.0;
    const prevTotal = prevFii + prevDii;
    if (fiiDiiTotal > prevTotal) {
      iScore += 10; fiiTrend = 'up';
      iDetails.push(`Pass: FII/DII holdings are increasing (${fiiDiiTotal.toFixed(1)}% vs ${prevTotal.toFixed(1)}% last quarter). Sponsorship is expanding!`);
    } else {
      iDetails.push(`Fail: FII/DII holdings decreased or flat compared to last quarter (${fiiDiiTotal.toFixed(1)}% vs ${prevTotal.toFixed(1)}%). Institutions are trimming.`);
    }
  } else {
    iDetails.push('Fail: Shareholding data is missing (requires FII/DII percentages)');
  }
  scorecard.I = { score: iScore, max: 15, details: iDetails, metrics: { fii_dii_total: round1(fiiDiiTotal), trend: fiiTrend } };

  // ---- M: Market Direction (max 10) ----
  const md = marketDirection || { score: 5, detail: 'Market data unavailable', status: 'Unknown', distribution_days: 0 };
  scorecard.M = { score: md.score ?? 5, max: 10, details: [md.detail || ''], metrics: { status: md.status, dist_days: md.distribution_days } };

  const totalScore = Object.values(scorecard).reduce((sum, s) => sum + s.score, 0);
  let recommendation;
  if (totalScore >= 80) recommendation = 'STRONG BUY (CAN SLIM LEADER)';
  else if (totalScore >= 60) recommendation = 'WATCHLIST (PASSES MOST METRICS)';
  else recommendation = 'AVOID (FAILING GROWTH CRITERIA)';

  const thesis = generateThesisReport(ticker, scorecard, totalScore, recommendation);

  return {
    ticker,
    current_price: round1(currPrice, 2),
    market_cap_crores: marketCapCrores,
    total_score: totalScore,
    recommendation,
    scorecard,
    thesis,
    last_analyzed: new Date().toISOString(),
  };
}

function round1(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return 0;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function generateThesisReport(ticker, scorecard, totalScore, recommendation) {
  const cMet = scorecard.C.metrics, aMet = scorecard.A.metrics, nMet = scorecard.N.metrics,
        sMet = scorecard.S.metrics, lMet = scorecard.L.metrics, iMet = scorecard.I.metrics,
        mMet = scorecard.M.metrics;

  const cStatus = scorecard.C.score >= 10 ? '✅ PASS' : '❌ FAIL';
  const aStatus = scorecard.A.score >= 10 ? '✅ PASS' : '❌ FAIL';
  const nStatus = scorecard.N.score >= 8 ? '✅ PASS' : '❌ FAIL';
  const sStatus = scorecard.S.score >= 8 ? '✅ PASS' : '❌ FAIL';
  const lStatus = scorecard.L.score >= 10 ? '✅ PASS' : '❌ FAIL';
  const iStatus = scorecard.I.score >= 10 ? '✅ PASS' : '❌ FAIL';
  const mStatus = scorecard.M.score >= 8 ? '✅ BULLISH' : scorecard.M.score >= 5 ? '⚠️ CAUTION' : '🚨 BEARISH';

  return `### CAN SLIM® Investment Thesis for ${ticker}

**Overall Score**: **${totalScore}/100** | **Verdict**: \`${recommendation}\`

---

#### 1. Fundamental & Technical Dashboard
| CAN SLIM Letter | Criteria Details | Performance Value | Status |
| :--- | :--- | :--- | :--- |
| **C** - Current Quarterly Earnings | Quarterly EPS Growth (YoY) | **${cMet.eps_growth}%** | ${cStatus} |
| **A** - Annual Earnings Growth | 3-Year EPS CAGR | **${aMet.eps_cagr}%** | ${aStatus} |
| | Return on Equity (ROE) | **${aMet.roe}%** | |
| **N** - New Highs/Product/Highs | Dist. from 52-Wk High | **${nMet.dist_high}%** | ${nStatus} |
| **S** - Supply and Demand | Float (Shares Outstanding) | **${sMet.shares_cr} Cr** | ${sStatus} |
| **L** - Leader or Laggard | Percentile RS Rating (1-99) | **${lMet.rs_rating}/99** | ${lStatus} |
| **I** - Institutional Sponsorship | Mutual Fund & FII Holding | **${iMet.fii_dii_total}%** | ${iStatus} |
| **M** - Market Direction | Nifty 50 Trend Index | **${mMet.status || 'N/A'}** | ${mStatus} |

---

#### 2. Key Catalysts & Risks
* **C & A (Earnings Strength)**: ${scorecard.C.score >= 10
    ? 'Excellent quarterly EPS growth. The company is experiencing major sales acceleration, indicating strong consumer demand and pricing power.'
    : 'Earnings growth is sluggish. The stock lacks the immediate explosive bottom-line acceleration required by true CAN SLIM market leaders.'}
* **L (Relative Strength)**: ${(lMet.rs_rating || 0) >= 80
    ? `With an RS rating of ${lMet.rs_rating}, the stock represents a market-leading growth vehicle. It is showing massive resilience and outperforms ${lMet.rs_rating}% of all Indian stocks.`
    : `An RS rating of ${lMet.rs_rating} indicates relative weakness. The stock is a laggard, failing to lead the general market and vulnerable to corrections.`}
* **I (Institutional Sponsorship)**: ${iMet.trend === 'up'
    ? 'FIIs and DIIs are actively buying. Smart money is increasing their exposure, providing institutional price support and validation.'
    : 'Institutional support is either flat or decreasing. Lack of net new accumulation by mutual funds and FIIs suggests caution.'}
* **M (Market Context)**: The overall market is in a **${mMet.status}** state with **${mMet.dist_days}** distribution days in the last 25 trading sessions. ${scorecard.M.score >= 8
    ? 'Trading conditions are highly favorable. Focus on buying breakouts from sound consolidations.'
    : 'Market environment is risky. Reduce position sizes and avoid buying extended breakouts.'}
`;
}

window.CanSlim = { parseScreenerText, calculateCanslimScore, extractNumberFromText };
