// IndiSmith App Logic

window.onerror = function(message, source, lineno, colno, error) {
    alert(`JS Error: ${message}\nAt: ${source}:${lineno}:${colno}\nStack: ${error ? error.stack : 'N/A'}`);
    return false;
};

function getParsedStocks() {
    try {
        const val = localStorage.getItem("parsed_stocks");
        if (!val) return {};
        const parsed = JSON.parse(val);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
        return {};
    }
}

let selectedSymbol = null;
let selectedStockData = null;
let currentUniverse = "nifty100";
let stocksList = [];
let chartInstance = null;

// Initialize on page load
document.addEventListener("DOMContentLoaded", () => {
    fetchMarketStatus();
    fetchStocksList();
    setupEventListeners();
});

// Setup event handlers
function setupEventListeners() {
    // Universe switching
    const uniButtons = document.querySelectorAll(".uni-btn");
    uniButtons.forEach(btn => {
        btn.addEventListener("click", (e) => {
            uniButtons.forEach(b => b.classList.remove("active"));
            e.target.classList.add("active");
            currentUniverse = e.target.getAttribute("data-uni");
            fetchStocksList();
        });
    });

    // Search input filtering
    const searchInput = document.getElementById("stock-search");
    searchInput.addEventListener("input", (e) => {
        filterStocks(e.target.value);
    });

    // Tab buttons switching
    const tabButtons = document.querySelectorAll(".tab-btn");
    tabButtons.forEach(btn => {
        btn.addEventListener("click", (e) => {
            tabButtons.forEach(b => b.classList.remove("active"));
            e.target.classList.add("active");
            
            const tabId = e.target.getAttribute("data-tab");
            switchTab(tabId);
        });
    });

    // Screener.in Submit
    const btnSubmit = document.getElementById("btn-submit-analysis");
    btnSubmit.addEventListener("click", () => {
        submitScreenerText();
    });

    // Manual RS cache update
    const btnUpdateRS = document.getElementById("btn-update-rs");
    btnUpdateRS.addEventListener("click", () => {
        triggerRSUpdate();
    });

    // Copy Prompt for Claude
    const btnCopyPrompt = document.getElementById("btn-copy-prompt");
    btnCopyPrompt.addEventListener("click", () => {
        copyPromptToClipboard();
    });

    // Risk Calculator Input Listeners
    ["calc-capital", "calc-risk-pct", "calc-entry-price"].forEach(id => {
        const input = document.getElementById(id);
        if (input) {
            input.addEventListener("input", calculateRiskPosition);
        }
    });
}

function calculateRiskPosition() {
    const capital = parseFloat(document.getElementById("calc-capital").value) || 0;
    const riskPct = parseFloat(document.getElementById("calc-risk-pct").value) || 0;
    const entryPrice = parseFloat(document.getElementById("calc-entry-price").value) || 0;

    if (capital <= 0 || entryPrice <= 0) return;

    const maxRiskAmt = capital * (riskPct / 100);
    const stopLossPrice = entryPrice * 0.93; // 7% O'Neil Stop-Loss Rule
    const riskPerShare = entryPrice - stopLossPrice;

    const shareQty = riskPerShare > 0 ? Math.floor(maxRiskAmt / riskPerShare) : 0;
    const totalAlloc = shareQty * entryPrice;
    const allocPct = capital > 0 ? ((totalAlloc / capital) * 100).toFixed(1) : 0;

    document.getElementById("res-risk-amt").innerText = `₹${Math.round(maxRiskAmt).toLocaleString('en-IN')}`;
    document.getElementById("res-stop-loss").innerText = `₹${stopLossPrice.toFixed(2)}`;
    document.getElementById("res-share-qty").innerText = `${shareQty} Shares`;
    document.getElementById("res-total-alloc").innerText = `₹${Math.round(totalAlloc).toLocaleString('en-IN')} (${allocPct}%)`;
}

// Switch tabs inside stock dashboard
function switchTab(tabId) {
    const tabContents = document.querySelectorAll(".tab-content");
    tabContents.forEach(content => content.classList.remove("active"));
    
    const activeTab = document.getElementById(tabId);
    if (activeTab) {
        activeTab.classList.add("active");
        
        // If switching to chart, render chart
        if (tabId === "tab-chart" && selectedStockData && selectedStockData.price_history) {
            // Wait slightly for container to display block
            setTimeout(() => {
                renderPriceChart(selectedStockData.price_history);
            }, 100);
        } else if (tabId === "tab-scanner") {
            loadScanner();
        }
    }
}

// Fetch Nifty 50 Index Status (M)
async function fetchMarketStatus() {
    try {
        const response = await fetch("data/market_direction.json");
        if (!response.ok) throw new Error("Failed to fetch market data");
        const data = await response.json();
        
        // Update header details
        document.getElementById("nifty-price").innerText = `₹${data.nifty_price.toLocaleString('en-IN')}`;
        document.getElementById("nifty-dist-days").innerText = data.distribution_days;
        
        const badge = document.getElementById("market-status-badge");
        badge.innerText = data.status;
        
        // Remove old classes and add correct badge class
        badge.className = "badge";
        if (data.status === "Confirmed Uptrend") {
            badge.classList.add("badge-bullish");
        } else if (data.status === "Uptrend Under Pressure") {
            badge.classList.add("badge-caution");
        } else {
            badge.classList.add("badge-bearish");
        }
        
        document.getElementById("market-status-banner").classList.remove("loading");
    } catch (e) {
        console.error("Error loading market trend:", e);
    }
}

// Fetch stocks list for the sidebar
async function fetchStocksList() {
    const container = document.getElementById("stock-list-container");
    container.innerHTML = '<div class="list-loading">Loading stock list...</div>';
    
    try {
        const [listResp, techResp, fundResp, mktResp] = await Promise.all([
            fetch(`data/${currentUniverse}.json`),
            fetch(`data/technicals.json`),
            fetch(`data/fundamentals.json`),
            fetch(`data/market_direction.json`)
        ]);
        
        if (!listResp.ok) throw new Error("Failed to fetch stock list");
        const listData = await listResp.json();
        const techData = techResp.ok ? await techResp.json() : {};
        const fundData = fundResp.ok ? await fundResp.json() : {};
        const mktData = mktResp.ok ? await mktResp.json() : {};

        stocksList = listData.map(st => {
            const sym = st.symbol;
            const tech = techData[sym] || {};
            const fund = fundData[sym] || {};
            
            let score = null;
            if (techData[sym] || fundData[sym]) {
                const evalRes = window.CanSlimEngine.evaluate(sym, tech, fund, mktData);
                score = evalRes.total_score;
            }

            return {
                symbol: sym,
                company_name: st.company_name,
                industry: st.industry,
                rs_rating: tech.rs_rating || 50,
                canslim_score: score
            };
        });

        // Sort stocks by RS rating descending
        stocksList.sort((a, b) => b.rs_rating - a.rs_rating);
        
        renderStockCards();
    } catch (e) {
        container.innerHTML = `<div class="list-error">Error loading stocks: ${e.message}</div>`;
    }
}

// Render stock cards in sidebar
function renderStockCards() {
    const container = document.getElementById("stock-list-container");
    container.innerHTML = "";
    
    if (stocksList.length === 0) {
        container.innerHTML = '<div class="list-empty">No stocks found.</div>';
        return;
    }
    
    // Check if there are cached analyses in localStorage to display green dots
    const parsedStocks = getParsedStocks();

    stocksList.forEach(stock => {
        const card = document.createElement("div");
        card.className = "stock-card";
        if (selectedSymbol === stock.symbol) {
            card.classList.add("active");
        }
        
        // Highlight high RS stocks
        if (stock.rs_rating >= 80) {
            card.classList.add("high-rs");
        }
        
        card.setAttribute("data-symbol", stock.symbol);
        
        // Check for score from backend or local storage
        const score = stock.canslim_score !== undefined && stock.canslim_score !== null ? stock.canslim_score : parsedStocks[stock.symbol];
        
        let scoreLabel = 'UNSCORED';
        let scoreClass = '';
        const hasParsedData = score !== undefined && score !== null;
        
        if (hasParsedData) {
            if (typeof score === 'number') {
                let verdictText = "AVOID";
                if (score >= 80) {
                    verdictText = "BUY";
                    scoreClass = 'score-pass';
                } else if (score >= 60) {
                    verdictText = "WATCH";
                    scoreClass = 'score-warn';
                } else {
                    scoreClass = 'score-fail';
                }
                scoreLabel = `${verdictText} (${score})`;
            } else {
                scoreLabel = 'SCORED';
            }
        }
        
        const parsedDotHtml = hasParsedData ? '<span class="parsed-dot"></span>' : '';
        
        card.innerHTML = `
            <div class="card-meta">
                <span class="card-sym">${stock.symbol} ${parsedDotHtml}</span>
                <span class="card-cname" title="${stock.company_name}">${stock.company_name}</span>
                <span class="card-ind">${stock.industry}</span>
            </div>
            <div class="card-badge">
                <span class="rs-rating-pill">RS ${stock.rs_rating}</span>
                <span class="score-tag-pill ${scoreClass}">${scoreLabel}</span>
            </div>
        `;
        
        card.addEventListener("click", () => {
            // Remove active class from other cards
            document.querySelectorAll(".stock-card").forEach(c => c.classList.remove("active"));
            card.classList.add("active");
            
            selectStock(stock);
        });
        
        container.appendChild(card);
    });
}

// Filter stocks inside the sidebar
function filterStocks(query) {
    const q = query.toLowerCase().trim();
    const cards = document.querySelectorAll(".stock-card");
    
    cards.forEach(card => {
        const sym = card.querySelector(".card-sym").innerText.toLowerCase();
        const name = card.querySelector(".card-cname").innerText.toLowerCase();
        if (sym.includes(q) || name.includes(q)) {
            card.style.display = "flex";
        } else {
            card.style.display = "none";
        }
    });
}

// Select stock from list and trigger analysis
async function selectStock(stock) {
    selectedSymbol = stock.symbol;
    
    // Display dashboard container, hide empty screen
    document.getElementById("no-selection-screen").style.display = "none";
    document.getElementById("stock-dashboard").style.display = "block";
    
    // Set hero tags to load basic details
    document.getElementById("hero-symbol").innerText = stock.symbol;
    document.getElementById("hero-name").innerText = stock.company_name;
    document.getElementById("hero-industry").innerText = stock.industry;
    document.getElementById("hero-rs-rating").innerText = stock.rs_rating;
    document.getElementById("hero-mcap").innerText = "MCap: Loading...";
    document.getElementById("hero-price").innerText = "Price: Loading...";
    
    // Update Screener.in link
    document.getElementById("screener-link").href = `https://www.screener.in/company/${stock.symbol}/`;
    
    // Reset Score circle
    updateScoreCircle(0);
    
    // Reset input textbox
    document.getElementById("screener-text-input").value = "";
    
    // Switch to Scorecard tab
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelector("[data-tab='tab-scorecard']").classList.add("active");
    switchTab("tab-scorecard");
    
    // Load cached pasted text if it exists in localStorage
    const savedText = localStorage.getItem(`screener_${stock.symbol}`);
    let textPayload = "";
    if (savedText) {
        document.getElementById("screener-text-input").value = savedText;
        textPayload = savedText;
    }
    
    // Fetch initial analysis (using yfinance + saved fundamentals if available)
    fetchAnalysis(stock.symbol, textPayload);
}

// Fetch CAN SLIM analysis from local static dataset
async function fetchAnalysis(symbol, screenerText = "") {
    try {
        const [techResp, fundResp, mktResp] = await Promise.all([
            fetch(`data/technicals.json`),
            fetch(`data/fundamentals.json`),
            fetch(`data/market_direction.json`)
        ]);
        
        const techData = techResp.ok ? await techResp.json() : {};
        const fundData = fundResp.ok ? await fundResp.json() : {};
        const mktData = mktResp.ok ? await mktResp.json() : {};

        const tech = techData[symbol] || {};
        const fund = fundData[symbol] || {};

        const data = window.CanSlimEngine.evaluate(symbol, tech, fund, mktData);
        data.thesis = generateStaticThesis(data, tech, fund);

        selectedStockData = data;
        
        // Update hero values & risk calculator entry price
        document.getElementById("hero-price").innerText = `Price: ₹${data.current_price.toLocaleString('en-IN')}`;
        document.getElementById("hero-mcap").innerText = `MCap: ${data.market_cap_crores.toLocaleString('en-IN')} Cr`;
        
        const entryInput = document.getElementById("calc-entry-price");
        if (entryInput && data.current_price) {
            entryInput.value = data.current_price;
            calculateRiskPosition();
        }

        // Update Pattern & Pivot Tags
        const high52 = tech.high_52 || data.current_price;
        const pivotTag = document.getElementById("pivot-price-tag");
        if (pivotTag) {
            pivotTag.innerText = `Breakout Pivot: ₹${high52 ? high52.toFixed(2) : '0.00'}`;
        }

        const patternTag = document.getElementById("pattern-detected-tag");
        if (patternTag) {
            const dist = tech.dist_high !== undefined ? tech.dist_high : 100;
            if (dist <= 5) {
                patternTag.innerText = "☕ Pattern: Cup-with-Handle (Pivot Breakout Alert!)";
            } else if (dist <= 15) {
                patternTag.innerText = "📐 Pattern: Volatility Contraction (VCP Base)";
            } else {
                patternTag.innerText = "📏 Pattern: Flat Base Consolidation";
            }
        }

        // Render Institutional Holding Progress Bars
        const shp = fund.shareholding || {};
        const instContainer = document.getElementById("inst-bar-container");
        if (instContainer) {
            instContainer.innerHTML = `
                <div class="inst-bar-item">
                    <div class="inst-bar-label"><span>FII Holding</span><span>${(shp.fii || 0).toFixed(1)}%</span></div>
                    <div class="inst-progress-bg"><div class="inst-progress-fill fii" style="width: ${Math.min(100, (shp.fii || 0))}%"></div></div>
                </div>
                <div class="inst-bar-item">
                    <div class="inst-bar-label"><span>DII / Mutual Funds</span><span>${(shp.dii || 0).toFixed(1)}%</span></div>
                    <div class="inst-progress-bg"><div class="inst-progress-fill dii" style="width: ${Math.min(100, (shp.dii || 0))}%"></div></div>
                </div>
                <div class="inst-bar-item">
                    <div class="inst-bar-label"><span>Promoter Stake</span><span>${(shp.promoters || 0).toFixed(1)}%</span></div>
                    <div class="inst-progress-bg"><div class="inst-progress-fill promoter" style="width: ${Math.min(100, (shp.promoters || 0))}%"></div></div>
                </div>
            `;
        }

        // Scorecard circles
        updateScoreCircle(data.total_score);
        
        // Render CAN SLIM verdict banner
        const verdictBanner = document.getElementById("verdict-banner");
        const verdictValue = document.getElementById("verdict-value");
        verdictValue.innerText = data.recommendation;
        verdictValue.className = "verdict-text";
        
        if (data.total_score >= 80) {
            verdictValue.classList.add("verdict-strong-buy");
        } else if (data.total_score >= 60) {
            verdictValue.classList.add("verdict-watchlist");
        } else {
            verdictValue.classList.add("verdict-avoid");
        }
        
        // Render each card (C, A, N, S, L, I, M)
        Object.keys(data.scorecard).forEach(letter => {
            const cardData = data.scorecard[letter];
            const card = document.getElementById(`card-${letter}`);
            const badge = document.getElementById(`badge-${letter}`);
            const detailsList = document.getElementById(`details-${letter}`);
            
            // Set points
            badge.innerText = `${cardData.score}/${cardData.max}`;
            
            // Set status color border
            card.className = "canslim-card";
            if (cardData.score >= (cardData.max * 0.65)) {
                card.classList.add("pass");
            } else if (cardData.score > 0) {
                card.classList.add("warn");
            } else {
                card.classList.add("fail");
            }
            
            // Set detailed list
            detailsList.innerHTML = "";
            cardData.details.forEach(bullet => {
                const li = document.createElement("li");
                
                // Premium HTML icon rendering based on details status
                if (bullet.startsWith("Pass:")) {
                    li.innerHTML = `<span class="li-icon pass-icon">✓</span> <span class="bullet-text">${bullet.substring(5).trim()}</span>`;
                    li.className = "detail-pass";
                } else if (bullet.startsWith("Fail:")) {
                    li.innerHTML = `<span class="li-icon fail-icon">✗</span> <span class="bullet-text">${bullet.substring(5).trim()}</span>`;
                    li.className = "detail-fail";
                } else if (bullet.startsWith("Warning:")) {
                    li.innerHTML = `<span class="li-icon warn-icon">⚠️</span> <span class="bullet-text">${bullet.substring(8).trim()}</span>`;
                    li.className = "detail-warn";
                } else if (bullet.startsWith("Checklist:")) {
                    li.innerHTML = `<span class="li-icon pass-icon">✓</span> <span class="bullet-text">${bullet.substring(10).trim()}</span>`;
                    li.className = "detail-pass";
                } else {
                    li.innerHTML = `<span class="li-icon neutral-icon">•</span> <span class="bullet-text">${bullet}</span>`;
                    li.className = "detail-neutral";
                }
                
                detailsList.appendChild(li);
            });
        });
        
        // Populate AI Thesis
        const thesisDiv = document.getElementById("thesis-content");
        thesisDiv.innerHTML = parseMarkdown(data.thesis);
        
        // Persist score in localStorage
        const parsedStocks = getParsedStocks();
        parsedStocks[symbol] = data.total_score;
        localStorage.setItem("parsed_stocks", JSON.stringify(parsedStocks));
        
        // Dynamically update sidebar card
        const card = document.querySelector(`.stock-card[data-symbol='${symbol}']`);
        if (card) {
            // Update green dot
            const symSpan = card.querySelector(".card-sym");
            if (symSpan && !symSpan.querySelector(".parsed-dot")) {
                const dot = document.createElement("span");
                dot.className = "parsed-dot";
                symSpan.appendChild(dot);
            }
            
            // Update score tag text and color class
            const tagSpan = card.querySelector(".score-tag-pill");
            if (tagSpan) {
                let verdictText = "AVOID";
                tagSpan.className = "score-tag-pill"; // clear old classes
                if (data.total_score >= 80) {
                    verdictText = "BUY";
                    tagSpan.classList.add("score-pass");
                } else if (data.total_score >= 60) {
                    verdictText = "WATCH";
                    tagSpan.classList.add("score-warn");
                } else {
                    tagSpan.classList.add("score-fail");
                }
                tagSpan.innerText = `${verdictText} (${data.total_score})`;
            }
        }
        
    } catch (e) {
        console.error("Error analyzing stock:", e);
    }
}

// Update the circular progress bar
function updateScoreCircle(score) {
    const circle = document.getElementById("score-circle-progress");
    const text = document.getElementById("hero-score-text");
    
    // Set text
    text.textContent = score;
    
    // SVG stroke-dasharray calculations
    // max score is 100, maps to dasharray limit of 100
    circle.setAttribute("stroke-dasharray", `${score}, 100`);
    
    // Color circle based on score range
    if (score >= 80) {
        circle.style.stroke = "var(--accent-green)";
    } else if (score >= 60) {
        circle.style.stroke = "var(--accent-amber)";
    } else {
        circle.style.stroke = "var(--accent-red)";
    }
}

// Submit pasted Screener.in text
async function submitScreenerText() {
    const text = document.getElementById("screener-text-input").value;
    if (!text.trim()) {
        alert("Please paste text from Screener.in first.");
        return;
    }
    
    const btn = document.getElementById("btn-submit-analysis");
    btn.innerText = "⏳ Running Math...";
    btn.disabled = true;
    
    try {
        // Run analysis
        await fetchAnalysis(selectedSymbol, text);
        
        // Save text payload to localStorage
        localStorage.setItem(`screener_${selectedSymbol}`, text);
        
        // Register this stock in our scored list
        const parsedStocks = getParsedStocks();
        parsedStocks[selectedSymbol] = true;
        localStorage.setItem("parsed_stocks", JSON.stringify(parsedStocks));
        
        // Update sidebar list cards (adds green dot)
        renderStockCards();
        
        // Switch to scorecard tab
        switchTab("tab-scorecard");
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        document.querySelector("[data-tab='tab-scorecard']").classList.add("active");
        
    } catch (e) {
        alert("Error executing analysis: " + e.message);
    } finally {
        btn.innerText = "🚀 Run CAN SLIM Analysis";
        btn.disabled = false;
    }
}

// Trigger RS Ratings recalculation
async function triggerRSUpdate() {
    const btn = document.getElementById("btn-update-rs");
    const originalText = btn.innerText;
    btn.innerText = "⏳ Recalculating (Background)...";
    btn.disabled = true;
    
    try {
        const response = await fetch("/api/update-rs", { method: "POST" });
        const result = await response.json();
        alert(result.message + "\nSidebar will refresh in 15 seconds. Please wait.");
        
        // Refresh sidebar stock list after 15 seconds
        setTimeout(() => {
            fetchStocksList();
            btn.innerText = originalText;
            btn.disabled = false;
        }, 15000);
    } catch (e) {
        alert("Failed to start RS update: " + e.message);
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

// Render Price & Volume Chart using Chart.js
function renderPriceChart(history) {
    const ctx = document.getElementById("priceChart").getContext("2d");
    
    if (chartInstance) {
        chartInstance.destroy();
    }
    
    // Sort history chronologically
    const sortedHist = [...history].sort((a, b) => new Date(a.date) - new Date(b.date));
    
    const labels = sortedHist.map(h => h.date);
    const prices = sortedHist.map(h => h.close);
    const volumes = sortedHist.map(h => h.volume);
    
    // Calculate 50 EMA and 200 EMA
    const ema50 = calculateEMA(sortedHist, 50);
    const ema200 = calculateEMA(sortedHist, 200);
    
    // Calculate 20-day average volume for highlight triggers
    const avgVol20 = [];
    for (let i = 0; i < sortedHist.length; i++) {
        if (i < 20) {
            avgVol20.push(null);
        } else {
            let sum = 0;
            for (let j = i - 19; j <= i; j++) {
                sum += sortedHist[j].volume;
            }
            avgVol20.push(sum / 20);
        }
    }
    
    // Color volume bars based on close vs open and volume spikes (accumulation vs distribution)
    const volumeColors = [];
    for (let i = 0; i < sortedHist.length; i++) {
        const candle = sortedHist[i];
        const isUp = candle.close >= candle.open;
        const isSpike = avgVol20[i] && candle.volume > (avgVol20[i] * 1.5);
        
        if (isUp) {
            volumeColors.push(isSpike ? "rgba(16, 185, 129, 0.9)" : "rgba(16, 185, 129, 0.4)");
        } else {
            volumeColors.push(isSpike ? "rgba(239, 68, 68, 0.9)" : "rgba(239, 68, 68, 0.4)");
        }
    }
    
    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Close Price (₹)',
                    data: prices,
                    borderColor: 'rgb(243, 244, 246)',
                    borderWidth: 2,
                    pointRadius: 0,
                    yAxisID: 'yPrice',
                    tension: 0.1
                },
                {
                    label: '50-day EMA',
                    data: ema50,
                    borderColor: 'rgb(245, 158, 11)',
                    borderWidth: 1.5,
                    pointRadius: 0,
                    yAxisID: 'yPrice',
                    tension: 0.1
                },
                {
                    label: '200-day EMA',
                    data: ema200,
                    borderColor: 'rgb(59, 130, 246)',
                    borderWidth: 1.5,
                    pointRadius: 0,
                    yAxisID: 'yPrice',
                    tension: 0.1
                },
                {
                    label: 'Volume',
                    type: 'bar',
                    data: volumes,
                    backgroundColor: volumeColors,
                    borderWidth: 0,
                    yAxisID: 'yVolume'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                legend: {
                    display: false // We use our custom styled legend
                },
                tooltip: {
                    backgroundColor: 'rgba(15, 20, 32, 0.95)',
                    titleColor: 'rgb(243, 244, 246)',
                    bodyColor: 'rgb(243, 244, 246)',
                    borderColor: 'rgba(255, 255, 255, 0.1)',
                    borderWidth: 1,
                    padding: 10,
                    titleFont: { family: 'Outfit', size: 12 },
                    bodyFont: { family: 'JetBrains Mono', size: 11 }
                }
            },
            scales: {
                x: {
                    grid: {
                        color: 'rgba(255, 255, 255, 0.03)'
                    },
                    ticks: {
                        color: '#6b7280',
                        font: { family: 'Outfit', size: 10 },
                        maxTicksLimit: 12
                    }
                },
                yPrice: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    },
                    ticks: {
                        color: '#9ca3af',
                        font: { family: 'JetBrains Mono', size: 10 },
                        callback: function(value) { return '₹' + value.toLocaleString('en-IN'); }
                    }
                },
                yVolume: {
                    type: 'linear',
                    display: false, // Don't show axis numbers, but let it render bars at bottom
                    position: 'right',
                    grid: {
                        drawOnChartArea: false
                    },
                    max: Math.max(...volumes) * 4 // Compresses volume bars to bottom 25% of chart
                }
            }
        }
    });
}

// Calculate EMA in JavaScript
function calculateEMA(data, period) {
    if (data.length < period) return Array(data.length).fill(null);
    
    let k = 2 / (period + 1);
    let ema = Array(data.length).fill(null);
    
    // Initial SMA for first value
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += data[i].close;
    }
    let sma = sum / period;
    ema[period - 1] = sma;
    
    // Rest are EMA
    for (let i = period; i < data.length; i++) {
        ema[i] = (data[i].close * k) + (ema[i - 1] * (1 - k));
    }
    
    return ema;
}

// Simple markdown parsing helper for AI Thesis tab
function parseMarkdown(md) {
    if (!md) return "No thesis generated yet.";
    
    let html = md;
    
    // Replace horizontal lines
    html = html.replace(/---/g, '<hr class="thesis-divider">');
    
    // Replace headings
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^#### (.*$)/gim, '<h4>$1</h4>');
    
    // Replace bold text
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    
    // Replace inline code blocks
    html = html.replace(/`(.*?)`/g, '<code class="code-badge">$1</code>');
    
    // Replace tables line-by-line to avoid catastrophic backtracking
    const lines = html.split('\n');
    let inTable = false;
    let tableHeaders = [];
    let tableRows = [];
    let newLines = [];
    
    for (let j = 0; j < lines.length; j++) {
        let line = lines[j].trim();
        if (line.startsWith('|') && line.endsWith('|')) {
            let cells = line.split('|').map(c => c.trim()).filter((c, idx, arr) => idx > 0 && idx < arr.length - 1);
            if (!inTable) {
                tableHeaders = cells;
                inTable = true;
                if (j + 1 < lines.length && lines[j+1].trim().startsWith('|') && lines[j+1].includes('---')) {
                    j++;
                }
            } else {
                tableRows.push(cells);
            }
        } else {
            if (inTable) {
                let tableHtml = '<table><thead><tr>';
                tableHeaders.forEach(h => { tableHtml += `<th>${h}</th>`; });
                tableHtml += '</tr></thead><tbody>';
                tableRows.forEach(row => {
                    tableHtml += '<tr>';
                    row.forEach(c => { tableHtml += `<td>${c}</td>`; });
                    tableHtml += '</tr>';
                });
                tableHtml += '</tbody></table>';
                newLines.push(tableHtml);
                inTable = false;
                tableHeaders = [];
                tableRows = [];
            }
            newLines.push(lines[j]);
        }
    }
    if (inTable) {
        let tableHtml = '<table><thead><tr>';
        tableHeaders.forEach(h => { tableHtml += `<th>${h}</th>`; });
        tableHtml += '</tr></thead><tbody>';
        tableRows.forEach(row => {
            tableHtml += '<tr>';
            row.forEach(c => { tableHtml += `<td>${c}</td>`; });
            tableHtml += '</tr>';
        });
        tableHtml += '</tbody></table>';
        newLines.push(tableHtml);
    }
    html = newLines.join('\n');

    // Replace list items
    html = html.replace(/^\* (.*$)/gim, '<li>$1</li>');
    // Group adjacent lists
    html = html.replace(/(<li>.*<\/li>)/g, '<ul>$1</ul>');
    // Remove nested double ul tags if regex misfired
    html = html.replace(/<\/ul>\s*<ul>/g, '');
    
    // Replace double newlines with paragraphs
    // Ensure we don't wrap tables and lists inside paragraphs
    const paragraphs = html.split('\n\n');
    html = paragraphs.map(p => {
        const clean = p.trim();
        if (!clean) return "";
        if (clean.startsWith('<h3>') || clean.startsWith('<h4>') || clean.startsWith('<table>') || clean.startsWith('<ul>') || clean.startsWith('<hr>')) {
            return clean;
        }
        return `<p>${clean}</p>`;
    }).join('');

    return html;
}

// Generate and copy Claude Prompt containing stock's quantitative data
function copyPromptToClipboard() {
    if (!selectedStockData) {
        alert("Please select a stock first.");
        return;
    }
    
    const d = selectedStockData;
    const c = d.scorecard["C"].metrics;
    const a = d.scorecard["A"].metrics;
    const n = d.scorecard["N"].metrics;
    const s = d.scorecard["S"].metrics;
    const l = d.scorecard["L"].metrics;
    const i = d.scorecard["I"].metrics;
    const m = d.scorecard["M"].metrics;
    
    // Retrieve copy pasted text from input
    const screenerText = document.getElementById("screener-text-input").value;
    
    const prompt = `I am analyzing the Indian stock **${d.ticker}** (Price: ₹${d.current_price}, Market Cap: ${d.market_cap_crores} Cr) using the CAN SLIM methodology.

Here is the quantitative data calculated by my local dashboard:
- **C (Current Quarterly EPS Growth)**: ${c.eps_growth}% (YoY), Sales Growth: ${c.sales_growth}%
- **A (Annual EPS CAGR)**: ${a.eps_cagr}% (over 3-5 years), Return on Equity (ROE): ${a.roe}%
- **N (New Highs/Product)**: Distance to 52-week high: ${n.dist_high}%
- **S (Supply/Demand)**: Shares outstanding: ${s.shares_cr} Crore shares, Volume ratio: ${s.volume_ratio}x of 20-day average
- **L (Relative Strength)**: IBD-style RS Rating of **${l.rs_rating}/99** compared to Nifty 500
- **I (Institutional Sponsorship)**: Mutual Funds/FII holding size: ${i.fii_dii_total}% (Trend: ${i.trend})
- **M (Market Direction)**: Nifty 50 Trend is **${m.status}** (Distribution days count: ${m.dist_days})

---
Here is the raw data I copied from Screener.in for this stock:
\`\`\`
${screenerText || "No screener text was pasted. Please perform qualitative research based on public reports."}
\`\`\`
---

Based on this quantitative CAN SLIM score of **${d.total_score}/100**, please write a deep qualitative evaluation:
1. Explain the stock's growth thesis and check its chart setup (Pivot breakouts, base structures like cup-with-handle).
2. Evaluate its fundamental drivers (new products, sector structural tailwinds, regulatory boosters).
3. Contrast the FII/DII accumulation with public holdings.
4. Give a definitive CAN SLIM checklist verdict with buy/watchlist/avoid recommendations.`;

    navigator.clipboard.writeText(prompt)
        .then(() => {
            alert("✅ Claude AI Analyst Prompt copied to clipboard! Paste it directly into your Claude or Gemini chat to get deep qualitative scorecard details.");
        })
        .catch(err => {
            console.error("Failed to copy prompt:", err);
            alert("Failed to copy prompt. Please select the prompt manually.");
        });
}

// Sector Scanner Logic
let scannerStocks = [];
let uniqueSectors = [];

function generateStaticThesis(data, tech, fund) {
    const sym = data.symbol;
    const score = data.total_score;
    const rec = data.recommendation;
    const mcap = data.market_cap_crores ? `${data.market_cap_crores.toLocaleString('en-IN')} Cr` : "N/A";
    const roe = fund.roe ? `${fund.roe.toFixed(1)}%` : "N/A";

    return `### Executive CAN SLIM Report for **${sym}**

- **Overall CAN SLIM Score**: **${score}/100**
- **Investment Verdict**: **${rec}**
- **Market Cap**: ₹${mcap} | **ROE**: ${roe}
- **Relative Strength Rating**: **${data.rs_rating}/99** vs Nifty 500

#### Key Takeaways & Thesis:
1. **Technicals & Base Setup**: Distance to 52-week high is **${tech.dist_high !== undefined ? tech.dist_high.toFixed(1) : 'N/A'}%**. Volume spike ratio is **${tech.volume_ratio || 1.0}x** of 20-day average.
2. **Growth Drivers**: Scraped financials indicate quarterly & annual earnings momentum aligned with O'Neil growth standards.
3. **Institutional Backing**: FII and DII holdings demonstrate steady institutional sponsorship.

> Use the **"Copy Data Prompt for Claude"** button below to generate a prompt for Claude/Gemini qualitative analysis!`;
}

async function loadScanner() {
    const select = document.getElementById("scanner-sector-select");
    const leadersList = document.getElementById("scanner-list-leaders");
    const watchlistList = document.getElementById("scanner-list-watchlist");
    const avoidList = document.getElementById("scanner-list-avoid");

    // Display loading
    leadersList.innerHTML = '<div class="scanner-status">Loading...</div>';
    watchlistList.innerHTML = '<div class="scanner-status">Loading...</div>';
    avoidList.innerHTML = '<div class="scanner-status">Loading...</div>';

    try {
        const [listResp, techResp, fundResp, mktResp] = await Promise.all([
            fetch("data/nifty500.json"),
            fetch("data/technicals.json"),
            fetch("data/fundamentals.json"),
            fetch("data/market_direction.json")
        ]);
        
        if (!listResp.ok) throw new Error("Failed to fetch scanner list");
        const listData = await listResp.json();
        const techData = techResp.ok ? await techResp.json() : {};
        const fundData = fundResp.ok ? await fundResp.json() : {};
        const mktData = mktResp.ok ? await mktResp.json() : {};

        const sectorsSet = new Set();
        scannerStocks = listData.map(st => {
            const sym = st.symbol;
            if (st.industry && st.industry !== "N/A") {
                sectorsSet.add(st.industry);
            }

            const tech = techData[sym] || {};
            const fund = fundData[sym] || {};

            let score = null;
            if (techData[sym] || fundData[sym]) {
                const evalRes = window.CanSlimEngine.evaluate(sym, tech, fund, mktData);
                score = evalRes.total_score;
            }

            return {
                symbol: sym,
                company_name: st.company_name,
                industry: st.industry,
                rs_rating: tech.rs_rating || 50,
                canslim_score: score
            };
        });

        // Sort scanner stocks by RS rating descending
        scannerStocks.sort((a, b) => b.rs_rating - a.rs_rating);
        uniqueSectors = Array.from(sectorsSet).sort();

        // Populate dropdown
        select.innerHTML = '<option value="ALL">All Sectors (Nifty 500)</option>';
        uniqueSectors.forEach(sector => {
            const opt = document.createElement("option");
            opt.value = sector;
            opt.innerText = sector;
            select.appendChild(opt);
        });

        // Set up select change listener if not done yet
        if (!select.dataset.listenerSet) {
            select.addEventListener("change", () => {
                renderScanner(select.value);
            });
            select.dataset.listenerSet = "true";
        }

        // Render initially with ALL
        renderScanner("ALL");

    } catch (e) {
        leadersList.innerHTML = `<div class="scanner-status error">Error: ${e.message}</div>`;
        watchlistList.innerHTML = '';
        avoidList.innerHTML = '';
    }
}

function renderScanner(selectedSector) {
    const leadersList = document.getElementById("scanner-list-leaders");
    const watchlistList = document.getElementById("scanner-list-watchlist");
    const avoidList = document.getElementById("scanner-list-avoid");

    leadersList.innerHTML = "";
    watchlistList.innerHTML = "";
    avoidList.innerHTML = "";

    const leaders = [];
    const watchlist = [];
    const avoid = [];

    // Filter stocks by sector
    const filteredStocks = selectedSector === "ALL" 
        ? scannerStocks 
        : scannerStocks.filter(s => s.industry === selectedSector);

    // Group stocks by score
    filteredStocks.forEach(stock => {
        const score = stock.canslim_score;
        if (score !== null && score !== undefined) {
            if (score >= 80) {
                leaders.push(stock);
            } else if (score >= 60) {
                watchlist.push(stock);
            } else {
                avoid.push(stock);
            }
        } else {
            // Unscored stocks go into Avoid/Unscored column but display with their RS rating
            avoid.push(stock);
        }
    });

    // Update column headers counts
    document.getElementById("count-leaders").innerText = leaders.length;
    document.getElementById("count-watchlist").innerText = watchlist.length;
    document.getElementById("count-avoid").innerText = avoid.length;

    // Helper to create list items
    const createScannerItem = (stock) => {
        const div = document.createElement("div");
        div.className = "scanner-item";
        
        const score = stock.canslim_score;
        let scorePill = '';
        if (score !== null && score !== undefined) {
            let badgeClass = 'score-fail';
            if (score >= 80) badgeClass = 'score-pass';
            else if (score >= 60) badgeClass = 'score-warn';
            
            scorePill = `<span class="score-tag-pill ${badgeClass}">Score ${score}</span>`;
        } else {
            scorePill = `<span class="score-tag-pill">Unscored</span>`;
        }

        div.innerHTML = `
            <div class="scanner-item-meta">
                <span class="scanner-item-sym">${stock.symbol}</span>
                <span class="scanner-item-name" title="${stock.company_name}">${stock.company_name}</span>
            </div>
            <div class="scanner-item-badges">
                <span class="rs-rating-pill">RS ${stock.rs_rating}</span>
                ${scorePill}
            </div>
        `;

        // Click handler to select stock
        div.addEventListener("click", () => {
            // Match with sidebar stock if available and click it
            const sidebarCard = document.querySelector(`.stock-card[data-symbol='${stock.symbol}']`);
            if (sidebarCard) {
                sidebarCard.click();
            } else {
                // Manually select stock and switch to analysis tab
                selectedSymbol = stock.symbol;
                
                // Show dashboard, hide empty screen
                document.getElementById("no-selection-screen").style.display = "none";
                document.getElementById("stock-dashboard").style.display = "block";
                
                document.getElementById("hero-symbol").innerText = stock.symbol;
                document.getElementById("hero-name").innerText = stock.company_name;
                document.getElementById("hero-industry").innerText = stock.industry;
                document.getElementById("hero-rs-rating").innerText = stock.rs_rating;
                document.getElementById("hero-mcap").innerText = "MCap: Loading...";
                document.getElementById("hero-price").innerText = "Price: Loading...";
                document.getElementById("screener-link").href = `https://www.screener.in/company/${stock.symbol}/`;
                updateScoreCircle(0);
                document.getElementById("screener-text-input").value = "";

                // Fetch data
                const savedText = localStorage.getItem(`screener_${stock.symbol}`);
                fetchAnalysis(stock.symbol, savedText || "");
            }

            // Switch back to scorecard tab
            switchTab("tab-scorecard");
            document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
            document.querySelector("[data-tab='tab-scorecard']").classList.add("active");
        });

        return div;
    };

    // Render items
    if (leaders.length === 0) {
        leadersList.innerHTML = '<div class="scanner-empty">No Leaders (Score 80+)</div>';
    } else {
        leaders.forEach(s => leadersList.appendChild(createScannerItem(s)));
    }

    if (watchlist.length === 0) {
        watchlistList.innerHTML = '<div class="scanner-empty">No Watchlist Stocks</div>';
    } else {
        watchlist.forEach(s => watchlistList.appendChild(createScannerItem(s)));
    }

    if (avoid.length === 0) {
        avoidList.innerHTML = '<div class="scanner-empty">No Avoid Stocks</div>';
    } else {
        // Sort unscored stocks by RS descending, and scored stocks at top
        const sortedAvoid = [...avoid].sort((a, b) => {
            const aScored = a.canslim_score !== null && a.canslim_score !== undefined;
            const bScored = b.canslim_score !== null && b.canslim_score !== undefined;
            if (aScored && !bScored) return -1;
            if (!aScored && bScored) return 1;
            return b.rs_rating - a.rs_rating;
        });
        sortedAvoid.forEach(s => avoidList.appendChild(createScannerItem(s)));
    }
}
