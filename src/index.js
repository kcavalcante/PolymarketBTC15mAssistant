import { CONFIG } from "./config.js";
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import {
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "./data/polymarket.js";
import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { detectRegime } from "./engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge, decide } from "./engines/edge.js";
import { appendCsvRow, formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import express from "express";
import { WebSocketServer } from "ws";
import { engineState, logEvent, evaluateSignals, setExecutorPortfolio } from "./engines/executor.js";
import { runWeatherConsensusSweep, weatherState, weatherEngineState, executeWeatherSignals } from "./engines/weatherEngine.js";
import { COINS } from "./coins.js";
import { createCoinEngine } from "./engines/coinEngine.js";
import { fetchPolymarketSnapshotForCoin } from "./data/coinMarketResolver.js";
import { loadPortfolio, loadEngineState, recordClosedTrade, appendTradeLog } from "./data/persistence.js";

const app = express();
app.use(express.static('public'));
const server = app.listen(3000, () => {
  // Silent boot for the dashboard on port 3000
});
const wss = new WebSocketServer({ server });

// ─── Persistência + engines multi-moeda ──────────────────────────────────────
const portfolio = loadPortfolio();

// Injetar portfolio no executor BTC para persistência
setExecutorPortfolio(portfolio);

// BTC usa executor.js (legacy); ETH/SOL/XRP usam coinEngine factory
// Restaurar saldo BTC do portfolio
const btcSaved = loadEngineState(portfolio, "BTC");
if (btcSaved.virtualBalance !== 0) engineState.virtualBalance = btcSaved.virtualBalance;
if (btcSaved.stats) Object.assign(engineState.stats, btcSaved.stats);

const altEngines = {}; // ETH, SOL, XRP
for (const coin of COINS.filter(c => c.key !== "BTC")) {
    altEngines[coin.key] = createCoinEngine(coin.key, portfolio);
}

// ─── Estado de tabs ───────────────────────────────────────────────────────────
const TABS = ["BTC", "ETH", "SOL", "XRP", "WEATHER", "OVERVIEW"];
let activeTab = "BTC";

// Capturas de snapshots das moedas alternativas (atualizadas em background)
const altSnapshots = { ETH: null, SOL: null, XRP: null };

// ─── Keyboard tab switching ───────────────────────────────────────────────────
if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", (str, key) => {
        if (key?.ctrl && key?.name === "c") process.exit();
        const idx = parseInt(str, 10) - 1;
        if (idx >= 0 && idx < TABS.length) activeTab = TABS[idx];
    });
}

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    try {
      const p = JSON.parse(message);
      if (p.action === "UPDATE_CONFIG") {
         if(p.timeframe) CONFIG.candleWindowMinutes = Number(p.timeframe);
         if(p.stopWin) CONFIG.stopWin = Number(p.stopWin);
         if(p.stopLoss) CONFIG.stopLoss = Number(p.stopLoss);
         if(p.stake) CONFIG.stakeAmount = Number(p.stake);
         logEvent("⚙️ Setup atualizado via Dashboard!");
      } else if (p.action === "TOGGLE_ENGINE") {
         engineState.status = engineState.status === "RUNNING" ? "STOPPED" : "RUNNING";
         logEvent(`Status do Motor alterado: ${engineState.status}`);
      }
    } catch(e) {}
  });
});

function broadcastData(data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(JSON.stringify(data));
  });
}

function countVwapCrosses(closes, vwapSeries, lookback) {
  if (closes.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] - vwapSeries[i - 1];
    const cur = closes[i] - vwapSeries[i];
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

applyGlobalProxyFromEnv();

function fmtTimeLeft(mins) {
  const totalSeconds = Math.max(0, Math.floor(mins * 60));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  lightRed: "\x1b[91m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  dim: "\x1b[2m"
};

function screenWidth() {
  const w = Number(process.stdout?.columns);
  return Number.isFinite(w) && w >= 40 ? w : 80;
}

function sepLine(ch = "─") {
  const w = screenWidth();
  return `${ANSI.white}${ch.repeat(w)}${ANSI.reset}`;
}

function renderScreen(text) {
  try {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  } catch {
    // ignore
  }
  process.stdout.write(text);
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function padLabel(label, width) {
  const visible = stripAnsi(label).length;
  if (visible >= width) return label;
  return label + " ".repeat(width - visible);
}

function centerText(text, width) {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  const left = Math.floor((width - visible) / 2);
  const right = width - visible - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

const LABEL_W = 16;
function kv(label, value) {
  const l = padLabel(String(label), LABEL_W);
  return `${l}${value}`;
}

function section(title) {
  return `${ANSI.white}${title}${ANSI.reset}`;
}

function colorPriceLine({ label, price, prevPrice, decimals = 0, prefix = "" }) {
  if (price === null || price === undefined) {
    return `${label}: ${ANSI.gray}-${ANSI.reset}`;
  }

  const p = Number(price);
  const prev = prevPrice === null || prevPrice === undefined ? null : Number(prevPrice);

  let color = ANSI.reset;
  let arrow = "";
  if (prev !== null && Number.isFinite(prev) && Number.isFinite(p) && p !== prev) {
    if (p > prev) {
      color = ANSI.green;
      arrow = " ↑";
    } else {
      color = ANSI.red;
      arrow = " ↓";
    }
  }

  const formatted = `${prefix}${formatNumber(p, decimals)}`;
  return `${label}: ${color}${formatted}${arrow}${ANSI.reset}`;
}

function formatSignedDelta(delta, base) {
  if (delta === null || base === null || base === 0) return `${ANSI.gray}-${ANSI.reset}`;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const pct = (Math.abs(delta) / Math.abs(base)) * 100;
  return `${sign}$${Math.abs(delta).toFixed(2)}, ${sign}${pct.toFixed(2)}%`;
}

function colorByNarrative(text, narrative) {
  if (narrative === "LONG") return `${ANSI.green}${text}${ANSI.reset}`;
  if (narrative === "SHORT") return `${ANSI.red}${text}${ANSI.reset}`;
  return `${ANSI.gray}${text}${ANSI.reset}`;
}

function formatNarrativeValue(label, value, narrative) {
  return `${label}: ${colorByNarrative(value, narrative)}`;
}

function narrativeFromSign(x) {
  if (x === null || x === undefined || !Number.isFinite(Number(x)) || Number(x) === 0) return "NEUTRAL";
  return Number(x) > 0 ? "LONG" : "SHORT";
}

function narrativeFromRsi(rsi) {
  if (rsi === null || rsi === undefined || !Number.isFinite(Number(rsi))) return "NEUTRAL";
  const v = Number(rsi);
  if (v >= 55) return "LONG";
  if (v <= 45) return "SHORT";
  return "NEUTRAL";
}

function narrativeFromSlope(slope) {
  if (slope === null || slope === undefined || !Number.isFinite(Number(slope)) || Number(slope) === 0) return "NEUTRAL";
  return Number(slope) > 0 ? "LONG" : "SHORT";
}

function formatProbPct(p, digits = 0) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return "-";
  return `${(Number(p) * 100).toFixed(digits)}%`;
}

function fmtEtTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
  } catch {
    return "-";
  }
}

function getBtcSession(now = new Date()) {
  const h = now.getUTCHours();
  const inAsia = h >= 0 && h < 8;
  const inEurope = h >= 7 && h < 16;
  const inUs = h >= 13 && h < 22;

  if (inEurope && inUs) return "Europe/US overlap";
  if (inAsia && inEurope) return "Asia/Europe overlap";
  if (inAsia) return "Asia";
  if (inEurope) return "Europe";
  if (inUs) return "US";
  return "Off-hours";
}

function parsePriceToBeat(market) {
  const text = String(market?.question ?? market?.title ?? "");
  if (!text) return null;
  const m = text.match(/price\s*to\s*beat[^\d$]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (!m) return null;
  const raw = m[1].replace(/,/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const dumpedMarkets = new Set();

function safeFileSlug(x) {
  return String(x ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 120);
}

function extractNumericFromMarket(market) {
  const directKeys = [
    "priceToBeat",
    "price_to_beat",
    "strikePrice",
    "strike_price",
    "strike",
    "threshold",
    "thresholdPrice",
    "threshold_price",
    "targetPrice",
    "target_price",
    "referencePrice",
    "reference_price"
  ];

  for (const k of directKeys) {
    const v = market?.[k];
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n)) return n;
  }

  const seen = new Set();
  const stack = [{ obj: market, depth: 0 }];

  while (stack.length) {
    const { obj, depth } = stack.pop();
    if (!obj || typeof obj !== "object") continue;
    if (seen.has(obj) || depth > 6) continue;
    seen.add(obj);

    const entries = Array.isArray(obj) ? obj.entries() : Object.entries(obj);
    for (const [key, value] of entries) {
      const k = String(key).toLowerCase();
      if (value && typeof value === "object") {
        stack.push({ obj: value, depth: depth + 1 });
        continue;
      }

      if (!/(price|strike|threshold|target|beat)/i.test(k)) continue;

      const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
      if (!Number.isFinite(n)) continue;

      if (n > 1000 && n < 2_000_000) return n;
    }
  }

  return null;
}

function priceToBeatFromPolymarketMarket(market) {
  const n = extractNumericFromMarket(market);
  if (n !== null) return n;
  return parsePriceToBeat(market);
}

const marketCache = {
  market: null,
  fetchedAtMs: 0
};

async function resolveCurrentBtc15mMarket() {
  if (CONFIG.polymarket.marketSlug) {
    return await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
  }

  if (!CONFIG.polymarket.autoSelectLatest) return null;

  const now = Date.now();
  if (marketCache.market && now - marketCache.fetchedAtMs < CONFIG.pollIntervalMs) {
    return marketCache.market;
  }

  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
  const markets = flattenEventMarkets(events);
  const picked = pickLatestLiveMarket(markets);

  marketCache.market = picked;
  marketCache.fetchedAtMs = now;
  return picked;
}

async function fetchPolymarketSnapshot() {
  const market = await resolveCurrentBtc15mMarket();

  if (!market) return { ok: false, reason: "market_not_found" };

  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
  const outcomePrices = Array.isArray(market.outcomePrices)
    ? market.outcomePrices
    : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);

  const clobTokenIds = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds
    : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

  let upTokenId = null;
  let downTokenId = null;
  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i]);
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;

    if (label.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (label.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());

  const gammaYes = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
  const gammaNo = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

  if (!upTokenId || !downTokenId) {
    return {
      ok: false,
      reason: "missing_token_ids",
      market,
      outcomes,
      clobTokenIds,
      outcomePrices
    };
  }

  let upBuy = null;
  let downBuy = null;
  let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
  let downBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };

  try {
    const [yesBuy, noBuy, upBook, downBook] = await Promise.all([
      fetchClobPrice({ tokenId: upTokenId, side: "buy" }),
      fetchClobPrice({ tokenId: downTokenId, side: "buy" }),
      fetchOrderBook({ tokenId: upTokenId }),
      fetchOrderBook({ tokenId: downTokenId })
    ]);

    upBuy = yesBuy;
    downBuy = noBuy;
    upBookSummary = summarizeOrderBook(upBook);
    downBookSummary = summarizeOrderBook(downBook);
  } catch {
    upBuy = null;
    downBuy = null;
    upBookSummary = {
      bestBid: Number(market.bestBid) || null,
      bestAsk: Number(market.bestAsk) || null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
    downBookSummary = {
      bestBid: null,
      bestAsk: null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
  }

  return {
    ok: true,
    market,
    tokens: { upTokenId, downTokenId },
    prices: {
      up: upBuy ?? gammaYes,
      down: downBuy ?? gammaNo
    },
    orderbook: {
      up: upBookSummary,
      down: downBookSummary
    }
  };
}

// ─── Tab bar ─────────────────────────────────────────────────────────────────
function renderTabBar() {
    const w   = screenWidth();
    const bar = TABS.map((t, i) => {
        const num    = i + 1;
        const active = t === activeTab;
        return active
            ? `${ANSI.white}[${num}:${t}]${ANSI.reset}`
            : `${ANSI.gray} ${num}:${t} ${ANSI.reset}`;
    }).join("  ");
    return `${bar}\n${sepLine()}`;
}

// ─── Render moeda alternativa (ETH/SOL/XRP) ──────────────────────────────────
function renderAltCoinTab(coinKey, snap, eng) {
    const coin  = COINS.find(c => c.key === coinKey);
    const label = coin?.label ?? coinKey;
    const lines = [renderTabBar(), ""];

    if (!snap) {
        lines.push(`  ${ANSI.yellow}⏳ Aguardando primeiro tick de ${label}...${ANSI.reset}`);
        renderScreen(lines.join("\n") + "\n");
        return;
    }

    if (snap.error) {
        lines.push(`  ${ANSI.red}❌ Erro em ${label}: ${snap.error}${ANSI.reset}`);
        renderScreen(lines.join("\n") + "\n");
        return;
    }

    const price    = snap.spotPrice ?? snap.lastPrice;
    const priceStr = price !== null ? `$${formatNumber(price, coin?.decimals ?? 2)}` : "-";
    const mUp      = snap.marketUp   !== null ? `${(snap.marketUp   * 100).toFixed(1)}¢` : "-";
    const mDown    = snap.marketDown !== null ? `${(snap.marketDown * 100).toFixed(1)}¢` : "-";
    const sigColor = snap.action === "ENTER" ? ANSI.green : ANSI.gray;
    const sigStr   = snap.action === "ENTER"
        ? `${ANSI.green}▶ ENTER ${snap.side} (${snap.phase} | ${snap.strength})${ANSI.reset}`
        : `${ANSI.gray}NO TRADE (${snap.phase ?? "-"})${ANSI.reset}`;

    const bal    = eng.state.virtualBalance;
    const balCol = bal > 0 ? ANSI.green : bal < 0 ? ANSI.red : ANSI.gray;
    const stats  = eng.state.stats;
    const wr     = stats.predictions > 0 ? ((stats.wins / stats.predictions) * 100).toFixed(0) : "-";

    lines.push(
        kv(`${label} (${coinKey}):`, `${ANSI.white}${priceStr}${ANSI.reset}`),
        kv("Sinal:", sigStr),
        kv("Polymarket:", snap.marketFound === false
            ? `${ANSI.yellow}Sem mercado ativo${ANSI.reset}`
            : `${ANSI.green}↑ UP${ANSI.reset} ${mUp}  |  ${ANSI.red}↓ DOWN${ANSI.reset} ${mDown}`),
        "",
        sepLine(), "",
        kv("Regime:", snap.regime ?? "-"),
        kv("RSI:", snap.rsiNow !== null ? formatNumber(snap.rsiNow, 1) : "-"),
        kv("VWAP dist:", snap.vwapDist !== null ? formatPct(snap.vwapDist, 2) : "-"),
        kv("Model UP:", snap.adjustedUp  !== null ? formatProbPct(snap.adjustedUp,  1) : "-"),
        kv("Model DOWN:", snap.adjustedDown !== null ? formatProbPct(snap.adjustedDown, 1) : "-"),
        kv("Edge UP:", snap.edgeUp   !== null ? formatNumber(snap.edgeUp,  4) : "-"),
        kv("Edge DOWN:", snap.edgeDown !== null ? formatNumber(snap.edgeDown, 4) : "-"),
        "",
        sepLine(), "",
        kv("Saldo virtual:", `${balCol}$${bal.toFixed(2)}${ANSI.reset}`),
        kv("Trades:", `${stats.predictions} (${stats.wins}W / ${stats.losses}L) — WR: ${wr}%`),
        "",
        sepLine(), "",
        section("► LOGS"),
        ...eng.state.logs.slice(0, 10).map(l => `  ${ANSI.dim}${l}${ANSI.reset}`),
        "",
        centerText(`${ANSI.dim}${ANSI.gray}created by @krajekis${ANSI.reset}`, screenWidth())
    );

    renderScreen(lines.join("\n") + "\n");
}

// ─── Render Weather tab ───────────────────────────────────────────────────────
function renderWeatherTab() {
    const lines = [renderTabBar(), ""];
    const wEng  = weatherEngineState;
    const bal   = wEng.virtualBalance;
    const balC  = bal > 0 ? ANSI.green : bal < 0 ? ANSI.red : ANSI.gray;
    const stats = wEng.stats;

    lines.push(
        section("🌡️  CLIMA — MOTOR DE TEMPERATURA"),
        "",
        kv("Status:", wEng.status === "RUNNING" ? `${ANSI.green}RUNNING${ANSI.reset}` : `${ANSI.red}STOPPED${ANSI.reset}`),
        kv("Saldo virtual:", `${balC}$${bal.toFixed(2)}${ANSI.reset}`),
        kv("Trades:", `${stats.predictions ?? 0} total`),
        kv("Última varredura:", weatherState.lastExecution),
        kv("Mercados monit.:", String(weatherState.marketsMonitored)),
        kv("Sinais ativos:", String(weatherState.matchesFound?.length ?? 0)),
        "",
        sepLine(), "",
        section("POSIÇÕES ABERTAS"),
        ...(wEng.activePositions.length === 0
            ? [`  ${ANSI.gray}Nenhuma posição aberta${ANSI.reset}`]
            : wEng.activePositions.map(p =>
                `  ${ANSI.green}NO${ANSI.reset} | ${p.city} | ${p.dateStr} | ` +
                `Threshold: ${p.targetC?.toFixed(0)}°C | Entrada: ${(p.entryPrice * 100).toFixed(1)}¢ | Stake: $${p.stake}`
            )),
        "",
        sepLine(), "",
        section("SCAN LOGS (última varredura)"),
        ...weatherState.scanLogs.slice(0, 15).map(l => `  ${ANSI.dim}${l}${ANSI.reset}`),
        "",
        sepLine(), "",
        section("ENGINE LOGS"),
        ...wEng.logs.slice(0, 8).map(l => `  ${ANSI.dim}${l}${ANSI.reset}`),
        "",
        centerText(`${ANSI.dim}${ANSI.gray}created by @krajekis${ANSI.reset}`, screenWidth())
    );

    renderScreen(lines.join("\n") + "\n");
}

// ─── Render Overview tab ──────────────────────────────────────────────────────
function renderOverviewTab(btcSnap) {
    const lines = [renderTabBar(), ""];
    const w     = screenWidth();

    // Linha de evolução ASCII do saldo BTC
    const btcHistory = portfolio.engines?.BTC?.balanceHistory ?? [];
    function sparkline(hist, width = 30) {
        if (hist.length < 2) return `${ANSI.gray}${"─".repeat(width)}${ANSI.reset}`;
        const vals  = hist.slice(-width).map(h => h.balance);
        const min   = Math.min(...vals);
        const max   = Math.max(...vals);
        const range = max - min || 1;
        const chars = ["▁","▂","▃","▄","▅","▆","▇","█"];
        return vals.map(v => {
            const idx = Math.min(7, Math.floor(((v - min) / range) * 8));
            const c   = chars[idx];
            const col = v >= 0 ? ANSI.green : ANSI.red;
            return `${col}${c}${ANSI.reset}`;
        }).join("");
    }

    // Tabela de engines
    const allEngines = [
        { key: "BTC",     eng: { state: engineState },      snap: btcSnap },
        { key: "ETH",     eng: altEngines["ETH"],           snap: altSnapshots["ETH"] },
        { key: "SOL",     eng: altEngines["SOL"],           snap: altSnapshots["SOL"] },
        { key: "XRP",     eng: altEngines["XRP"],           snap: altSnapshots["XRP"] },
        { key: "WEATHER", eng: { state: weatherEngineState }, snap: null }
    ];

    let totalBalance = 0;
    let totalPreds   = 0;
    let totalWins    = 0;

    const tableRows = allEngines.map(({ key, eng }) => {
        const s   = eng.state;
        const bal = s.virtualBalance ?? 0;
        totalBalance += bal;
        totalPreds   += s.stats?.predictions ?? 0;
        totalWins    += s.stats?.wins        ?? 0;
        const wr     = (s.stats?.predictions ?? 0) > 0
            ? `${((s.stats.wins / s.stats.predictions) * 100).toFixed(0)}%`
            : "-";
        const balC   = bal > 0 ? ANSI.green : bal < 0 ? ANSI.red : ANSI.gray;
        const pos    = (s.activePositions?.length ?? 0);
        const signal = key !== "WEATHER" && altSnapshots[key]?.action === "ENTER"
            ? `${ANSI.green}▶ ENTER${ANSI.reset}`
            : (key === "BTC" && btcSnap?.action === "ENTER" ? `${ANSI.green}▶ ENTER${ANSI.reset}` : `${ANSI.gray}NO TRADE${ANSI.reset}`);
        return `  ${padLabel(key, 8)} | ${balC}$${bal.toFixed(2).padStart(8)}${ANSI.reset} | ` +
               `${String(s.stats?.predictions ?? 0).padStart(4)} trades | WR: ${wr.padStart(5)} | ` +
               `Pos: ${pos} | ${signal}`;
    });

    const totalWr  = totalPreds > 0 ? `${((totalWins / totalPreds) * 100).toFixed(0)}%` : "-";
    const totC     = totalBalance > 0 ? ANSI.green : totalBalance < 0 ? ANSI.red : ANSI.gray;

    // Posições abertas consolidadas
    const allActive = [
        ...engineState.activePositions.map(p => ({ ...p, coin: "BTC" })),
        ...Object.entries(altEngines).flatMap(([k, e]) =>
            e.state.activePositions.map(p => ({ ...p, coin: k }))),
        ...weatherEngineState.activePositions.map(p => ({ ...p, coin: "WEATHER" }))
    ];

    // Últimos trades fechados (todos os engines)
    const recentClosed = [
        ...engineState.closedPositions.slice(-5).map(p => ({ ...p, coin: "BTC" })),
        ...Object.entries(altEngines).flatMap(([k, e]) =>
            e.state.closedPositions.slice(-3).map(p => ({ ...p, coin: k }))),
        ...weatherEngineState.closedPositions.slice(-3).map(p => ({ ...p, coin: "WEATHER" }))
    ].sort((a, b) => (b.closedAt ?? b.time ?? 0) - (a.closedAt ?? a.time ?? 0)).slice(0, 10);

    lines.push(
        section("VISÃO GERAL — PORTFÓLIO"),
        "",
        `  ${"Ativo".padEnd(8)} | ${"Saldo".padEnd(10)} | ${"Trades".padEnd(10)} | ${"WR".padEnd(7)} | ${"Pos".padEnd(4)} | Sinal`,
        `  ${"─".repeat(w - 4)}`,
        ...tableRows,
        `  ${"─".repeat(w - 4)}`,
        `  ${"TOTAL".padEnd(8)} | ${totC}$${totalBalance.toFixed(2).padStart(8)}${ANSI.reset} | ` +
        `${String(totalPreds).padStart(4)} trades | WR: ${totalWr.padStart(5)}`,
        "",
        sepLine(), "",
        section("EVOLUÇÃO DO SALDO (BTC)"),
        `  ${sparkline(btcHistory, Math.min(60, w - 4))}`,
        `  ${ANSI.gray}${btcHistory.length} snapshots salvos${ANSI.reset}`,
        "",
        sepLine(), "",
        section("POSIÇÕES ABERTAS"),
        ...(allActive.length === 0
            ? [`  ${ANSI.gray}Nenhuma posição aberta${ANSI.reset}`]
            : allActive.map(p =>
                `  [${p.coin}] ${p.side ?? "NO"} | Entrada: ${((p.entryPrice ?? 0) * 100).toFixed(1)}¢ | ` +
                `Atual: ${((p.currentPrice ?? 0) * 100).toFixed(1)}¢ | ` +
                `Stake: $${CONFIG.stakeAmount}`
            )),
        "",
        sepLine(), "",
        section("ÚLTIMOS TRADES FECHADOS"),
        ...(recentClosed.length === 0
            ? [`  ${ANSI.gray}Nenhum trade fechado ainda${ANSI.reset}`]
            : recentClosed.map(p => {
                const pnlC = (p.pnl ?? 0) >= 0 ? ANSI.green : ANSI.red;
                const sign = (p.pnl ?? 0) >= 0 ? "+" : "";
                return `  [${p.coin}] ${p.side ?? "?"} | ` +
                    `${((p.entryPrice ?? 0) * 100).toFixed(1)}¢ → ${((p.exitPrice ?? 0) * 100).toFixed(1)}¢ | ` +
                    `${pnlC}PnL: ${sign}$${(p.pnl ?? 0).toFixed(2)}${ANSI.reset}`;
            })),
        "",
        centerText(`${ANSI.dim}${ANSI.gray}created by @krajekis${ANSI.reset}`, w)
    );

    renderScreen(lines.join("\n") + "\n");
}

async function main() {
  const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  const chainlinkStream = startChainlinkPriceStream({});

  // Inicia o oráculo de clima de 5 em 5 minutos (Não bloqueante)
  runWeatherConsensusSweep().then(executeWeatherSignals);
  setInterval(() => {
    runWeatherConsensusSweep().then(executeWeatherSignals);
  }, 300_000);

  // ─── Análise das moedas alternativas (ETH/SOL/XRP) em paralelo ──────────────
  // Roda a cada 3 segundos (não precisa ser tick-a-tick como BTC)
  const altWsStreams = {};
  for (const coin of COINS.filter(c => c.key !== "BTC")) {
      altWsStreams[coin.key] = startBinanceTradeStream({ symbol: coin.symbol });
  }

  async function runAltCoinAnalysis(coin) {
      const wsPrice = altWsStreams[coin.key]?.getLast()?.price ?? null;
      try {
          const timing    = getCandleWindowTiming(CONFIG.candleWindowMinutes);
          const [klines1m, lastPrice, poly] = await Promise.all([
              fetchKlines({ interval: "1m", limit: 240, symbol: coin.symbol }),
              fetchLastPrice({ symbol: coin.symbol }),
              fetchPolymarketSnapshotForCoin(coin)
          ]);

          const settlementMs  = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
          const timeLeftMin   = settlementMs ? (settlementMs - Date.now()) / 60_000 : timing.remainingMinutes;
          const closes        = klines1m.map(c => c.close);
          const vwapSeries    = computeVwapSeries(klines1m);
          const vwapNow       = vwapSeries[vwapSeries.length - 1];
          const lookback      = CONFIG.vwapSlopeLookbackMinutes;
          const vwapSlope     = vwapSeries.length >= lookback ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback : null;
          const vwapDist      = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;
          const rsiNow        = computeRsi(closes, CONFIG.rsiPeriod);
          const rsiWindow     = closes.slice(-(CONFIG.rsiPeriod + 21));
          const rsiSeries     = [];
          for (let i = CONFIG.rsiPeriod; i < rsiWindow.length; i++) {
              const r = computeRsi(rsiWindow.slice(0, i + 1), CONFIG.rsiPeriod);
              if (r !== null) rsiSeries.push(r);
          }
          const rsiSlope      = slopeLast(rsiSeries, 3);
          const macd          = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);
          const ha            = computeHeikenAshi(klines1m);
          const consec        = countConsecutive(ha);
          const failedVwap    = vwapNow !== null && vwapSeries.length >= 3
              ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
              : false;
          const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);
          const volumeRecent   = klines1m.slice(-20).reduce((a, c) => a + c.volume, 0);
          const volumeAvg      = klines1m.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;
          const regimeInfo     = detectRegime({ price: lastPrice, vwap: vwapNow, vwapSlope, vwapCrossCount, volumeRecent, volumeAvg });
          const scored         = scoreDirection({ price: lastPrice, vwap: vwapNow, vwapSlope, rsi: rsiNow, rsiSlope, macd, heikenColor: consec.color, heikenCount: consec.count, failedVwapReclaim: failedVwap });
          const timeAware      = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);
          const marketUp       = poly.ok ? poly.prices.up   : null;
          const marketDown     = poly.ok ? poly.prices.down : null;
          const edge           = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });
          const rec            = decide({ remainingMinutes: timeLeftMin, edgeUp: edge.edgeUp, edgeDown: edge.edgeDown, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown });

          altSnapshots[coin.key] = {
              coinKey: coin.key, spotPrice: wsPrice ?? lastPrice, lastPrice,
              marketFound: poly.ok, marketQuestion: poly.market?.question ?? null,
              marketUp, marketDown, timeLeftMin, phase: rec.phase,
              vwapNow, vwapSlope, vwapDist, rsiNow, rsiSlope, macd,
              heikenColor: consec.color, heikenCount: consec.count,
              regime: regimeInfo.regime, upScore: scored.upScore, downScore: scored.downScore,
              adjustedUp: timeAware.adjustedUp, adjustedDown: timeAware.adjustedDown,
              edgeUp: edge.edgeUp, edgeDown: edge.edgeDown,
              bestEdge: rec.bestEdge, bestModel: rec.bestModel,
              threshold: rec.threshold, minProb: rec.minProb,
              action: rec.action, side: rec.side, strength: rec.strength, reason: rec.reason,
              upTokenId: poly.ok ? poly.tokens?.upTokenId   : null,
              downTokenId: poly.ok ? poly.tokens?.downTokenId : null,
              error: null
          };

          // Executar sinal
          const eng = altEngines[coin.key];
          eng.evaluateSignals({
              signal:     rec.action === "ENTER" ? `ENTER (${rec.side})` : "NO_TRADE",
              marketUp, marketDown,
              upTokenId:  altSnapshots[coin.key].upTokenId,
              downTokenId: altSnapshots[coin.key].downTokenId,
              phase: rec.phase, side: rec.side, reason: rec.reason,
              timeLeftMin, bestEdge: rec.bestEdge, bestModel: rec.bestModel,
              threshold: rec.threshold, minProb: rec.minProb,
              upScore: scored.upScore, downScore: scored.downScore,
              regime: regimeInfo.regime
          });

      } catch (err) {
          altSnapshots[coin.key] = { coinKey: coin.key, error: err?.message ?? String(err), action: "NO_TRADE" };
      }
  }

  // Rodar análises alternativas a cada 3s (não bloqueia o tick BTC)
  setInterval(() => {
      Promise.allSettled(COINS.filter(c => c.key !== "BTC").map(runAltCoinAnalysis));
  }, 3_000);

  let prevSpotPrice = null;
  let prevCurrentPrice = null;
  let priceToBeatState = { slug: null, value: null, setAtMs: null };

  const header = [
    "timestamp",
    "entry_minute",
    "time_left_min",
    "regime",
    "signal",
    "model_up",
    "model_down",
    "mkt_up",
    "mkt_down",
    "edge_up",
    "edge_down",
    "recommendation"
  ];

  while (true) {
    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

    const wsTick = binanceStream.getLast();
    const wsPrice = wsTick?.price ?? null;

    const polymarketWsTick = polymarketLiveStream.getLast();
    const polymarketWsPrice = polymarketWsTick?.price ?? null;

    const chainlinkWsTick = chainlinkStream.getLast();
    const chainlinkWsPrice = chainlinkWsTick?.price ?? null;

    try {
      const chainlinkPromise = polymarketWsPrice !== null
        ? Promise.resolve({ price: polymarketWsPrice, updatedAt: polymarketWsTick?.updatedAt ?? null, source: "polymarket_ws" })
        : chainlinkWsPrice !== null
          ? Promise.resolve({ price: chainlinkWsPrice, updatedAt: chainlinkWsTick?.updatedAt ?? null, source: "chainlink_ws" })
          : fetchChainlinkBtcUsd();

      const [klines1m, lastPrice, chainlink, poly] = await Promise.all([
        fetchKlines({ interval: "1m", limit: 240 }),
        fetchLastPrice(),
        chainlinkPromise,
        fetchPolymarketSnapshot()
      ]);

      const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
      const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;

      const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

      const candles = klines1m;
      const closes = candles.map((c) => c.close);

      const vwap = computeSessionVwap(candles);
      const vwapSeries = computeVwapSeries(candles);
      const vwapNow = vwapSeries[vwapSeries.length - 1];

      const lookback = CONFIG.vwapSlopeLookbackMinutes;
      const vwapSlope = vwapSeries.length >= lookback ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback : null;
      const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

      const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
      // RSI series: apenas os últimos 20 pontos — suficiente para sma(14) e slope(3)
      // Evita O(n²): ao invés de 240 slices, usa janela fixa de ~35 closes
      const RSI_SERIES_LOOKBACK = 20;
      const rsiWindow = closes.slice(-(CONFIG.rsiPeriod + RSI_SERIES_LOOKBACK + 1));
      const rsiSeries = [];
      for (let i = CONFIG.rsiPeriod; i < rsiWindow.length; i += 1) {
        const r = computeRsi(rsiWindow.slice(0, i + 1), CONFIG.rsiPeriod);
        if (r !== null) rsiSeries.push(r);
      }
      const rsiMa = sma(rsiSeries, CONFIG.rsiMaPeriod);
      const rsiSlope = slopeLast(rsiSeries, 3);

      const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);

      const ha = computeHeikenAshi(candles);
      const consec = countConsecutive(ha);

      const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);
      const volumeRecent = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
      const volumeAvg = candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;

      const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
        ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
        : false;

      const regimeInfo = detectRegime({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        vwapCrossCount,
        volumeRecent,
        volumeAvg
      });

      const scored = scoreDirection({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        rsi: rsiNow,
        rsiSlope,
        macd,
        heikenColor: consec.color,
        heikenCount: consec.count,
        failedVwapReclaim
      });

      const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);

      const marketUp = poly.ok ? poly.prices.up : null;
      const marketDown = poly.ok ? poly.prices.down : null;
      const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });

      const rec = decide({ remainingMinutes: timeLeftMin, edgeUp: edge.edgeUp, edgeDown: edge.edgeDown, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown });

      const vwapSlopeLabel = vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";

      const macdLabel = macd === null
        ? "-"
        : macd.hist < 0
          ? (macd.histDelta !== null && macd.histDelta < 0 ? "bearish (expanding)" : "bearish")
          : (macd.histDelta !== null && macd.histDelta > 0 ? "bullish (expanding)" : "bullish");

      const lastCandle = klines1m.length ? klines1m[klines1m.length - 1] : null;
      const lastClose = lastCandle?.close ?? null;
      const close1mAgo = klines1m.length >= 2 ? klines1m[klines1m.length - 2]?.close ?? null : null;
      const close3mAgo = klines1m.length >= 4 ? klines1m[klines1m.length - 4]?.close ?? null : null;
      const delta1m = lastClose !== null && close1mAgo !== null ? lastClose - close1mAgo : null;
      const delta3m = lastClose !== null && close3mAgo !== null ? lastClose - close3mAgo : null;

      const haNarrative = (consec.color ?? "").toLowerCase() === "green" ? "LONG" : (consec.color ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL";
      const rsiNarrative = narrativeFromSlope(rsiSlope);
      const macdNarrative = narrativeFromSign(macd?.hist ?? null);
      const vwapNarrative = narrativeFromSign(vwapDist);

      const pLong = timeAware?.adjustedUp ?? null;
      const pShort = timeAware?.adjustedDown ?? null;
      const predictNarrative = (pLong !== null && pShort !== null && Number.isFinite(pLong) && Number.isFinite(pShort))
        ? (pLong > pShort ? "LONG" : pShort > pLong ? "SHORT" : "NEUTRAL")
        : "NEUTRAL";
      const predictValue = `${ANSI.green}LONG${ANSI.reset} ${ANSI.green}${formatProbPct(pLong, 0)}${ANSI.reset} / ${ANSI.red}SHORT${ANSI.reset} ${ANSI.red}${formatProbPct(pShort, 0)}${ANSI.reset}`;
      const predictLine = `Predict: ${predictValue}`;

      const marketUpStr = `${marketUp ?? "-"}${marketUp === null || marketUp === undefined ? "" : "¢"}`;
      const marketDownStr = `${marketDown ?? "-"}${marketDown === null || marketDown === undefined ? "" : "¢"}`;
      const polyHeaderValue = `${ANSI.green}↑ UP${ANSI.reset} ${marketUpStr}  |  ${ANSI.red}↓ DOWN${ANSI.reset} ${marketDownStr}`;

      const heikenValue = `${consec.color ?? "-"} x${consec.count}`;
      const heikenLine = formatNarrativeValue("Heiken Ashi", heikenValue, haNarrative);

      const rsiArrow = rsiSlope !== null && rsiSlope < 0 ? "↓" : rsiSlope !== null && rsiSlope > 0 ? "↑" : "-";
      const rsiValue = `${formatNumber(rsiNow, 1)} ${rsiArrow}`;
      const rsiLine = formatNarrativeValue("RSI", rsiValue, rsiNarrative);

      const macdLine = formatNarrativeValue("MACD", macdLabel, macdNarrative);

      const delta1Narrative = narrativeFromSign(delta1m);
      const delta3Narrative = narrativeFromSign(delta3m);
      const deltaValue = `${colorByNarrative(formatSignedDelta(delta1m, lastClose), delta1Narrative)} | ${colorByNarrative(formatSignedDelta(delta3m, lastClose), delta3Narrative)}`;
      const deltaLine = `Delta 1/3Min: ${deltaValue}`;

      const vwapValue = `${formatNumber(vwapNow, 0)} (${formatPct(vwapDist, 2)}) | slope: ${vwapSlopeLabel}`;
      const vwapLine = formatNarrativeValue("VWAP", vwapValue, vwapNarrative);

      const signal = rec.action === "ENTER" ? (rec.side === "UP" ? "BUY UP" : "BUY DOWN") : "NO TRADE";

      const actionLine = rec.action === "ENTER"
        ? `${rec.action} NOW (${rec.phase} ENTRY)`
        : `NO TRADE (${rec.phase})`;

      const spreadUp = poly.ok ? poly.orderbook.up.spread : null;
      const spreadDown = poly.ok ? poly.orderbook.down.spread : null;

      const spread = spreadUp !== null && spreadDown !== null ? Math.max(spreadUp, spreadDown) : (spreadUp ?? spreadDown);
      const liquidity = poly.ok
        ? (Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null)
        : null;

      const spotPrice = wsPrice ?? lastPrice;
      const currentPrice = chainlink?.price ?? null;
      const marketSlug = poly.ok ? String(poly.market?.slug ?? "") : "";
      const marketStartMs = poly.ok && poly.market?.eventStartTime ? new Date(poly.market.eventStartTime).getTime() : null;

      if (marketSlug && priceToBeatState.slug !== marketSlug) {
        priceToBeatState = { slug: marketSlug, value: null, setAtMs: null };
      }

      if (priceToBeatState.slug && priceToBeatState.value === null && currentPrice !== null) {
        const nowMs = Date.now();
        const okToLatch = marketStartMs === null ? true : nowMs >= marketStartMs;
        if (okToLatch) {
          priceToBeatState = { slug: priceToBeatState.slug, value: Number(currentPrice), setAtMs: nowMs };
        }
      }

      const priceToBeat = priceToBeatState.slug === marketSlug ? priceToBeatState.value : null;
      const currentPriceBaseLine = colorPriceLine({
        label: "CURRENT PRICE",
        price: currentPrice,
        prevPrice: prevCurrentPrice,
        decimals: 2,
        prefix: "$"
      });

      const ptbDelta = (currentPrice !== null && priceToBeat !== null && Number.isFinite(currentPrice) && Number.isFinite(priceToBeat))
        ? currentPrice - priceToBeat
        : null;
      const ptbDeltaColor = ptbDelta === null
        ? ANSI.gray
        : ptbDelta > 0
          ? ANSI.green
          : ptbDelta < 0
            ? ANSI.red
            : ANSI.gray;
      const ptbDeltaText = ptbDelta === null
        ? `${ANSI.gray}-${ANSI.reset}`
        : `${ptbDeltaColor}${ptbDelta > 0 ? "+" : ptbDelta < 0 ? "-" : ""}$${Math.abs(ptbDelta).toFixed(2)}${ANSI.reset}`;
      const currentPriceValue = currentPriceBaseLine.split(": ")[1] ?? currentPriceBaseLine;
      const currentPriceLine = kv("CURRENT PRICE:", `${currentPriceValue} (${ptbDeltaText})`);

      if (poly.ok && poly.market && priceToBeatState.value === null) {
        const slug = safeFileSlug(poly.market.slug || poly.market.id || "market");
        if (slug && !dumpedMarkets.has(slug)) {
          dumpedMarkets.add(slug);
          try {
            fs.mkdirSync("./logs", { recursive: true });
            fs.writeFileSync(path.join("./logs", `polymarket_market_${slug}.json`), JSON.stringify(poly.market, null, 2), "utf8");
          } catch {
            // ignore
          }
        }
      }

      const binanceSpotBaseLine = colorPriceLine({ label: "BTC (Binance)", price: spotPrice, prevPrice: prevSpotPrice, decimals: 0, prefix: "$" });
      const diffLine = (spotPrice !== null && currentPrice !== null && Number.isFinite(spotPrice) && Number.isFinite(currentPrice) && currentPrice !== 0)
        ? (() => {
          const diffUsd = spotPrice - currentPrice;
          const diffPct = (diffUsd / currentPrice) * 100;
          const sign = diffUsd > 0 ? "+" : diffUsd < 0 ? "-" : "";
          return ` (${sign}$${Math.abs(diffUsd).toFixed(2)}, ${sign}${Math.abs(diffPct).toFixed(2)}%)`;
        })()
        : "";
      const binanceSpotLine = `${binanceSpotBaseLine}${diffLine}`;
      const binanceSpotValue = binanceSpotLine.split(": ")[1] ?? binanceSpotLine;
      const binanceSpotKvLine = kv("BTC (Binance):", binanceSpotValue);

      const titleLine = poly.ok ? `${poly.market?.question ?? "-"}` : "-";
      const marketLine = kv("Market:", poly.ok ? (poly.market?.slug ?? "-") : "-");

      const timeColor = timeLeftMin >= 10 && timeLeftMin <= 15
        ? ANSI.green
        : timeLeftMin >= 5 && timeLeftMin < 10
          ? ANSI.yellow
          : timeLeftMin >= 0 && timeLeftMin < 5
            ? ANSI.red
            : ANSI.reset;
      const timeLeftLine = `⏱ Time left: ${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`;

      const polyTimeLeftColor = settlementLeftMin !== null
        ? (settlementLeftMin >= 10 && settlementLeftMin <= 15
          ? ANSI.green
          : settlementLeftMin >= 5 && settlementLeftMin < 10
            ? ANSI.yellow
            : settlementLeftMin >= 0 && settlementLeftMin < 5
              ? ANSI.red
              : ANSI.reset)
        : ANSI.reset;

      const btcSnap = {
          action: rec.action, side: rec.side, phase: rec.phase, strength: rec.strength,
          spotPrice: spotPrice, adjustedUp: timeAware.adjustedUp, adjustedDown: timeAware.adjustedDown,
          edgeUp: edge.edgeUp, edgeDown: edge.edgeDown, regime: regimeInfo.regime
      };

      // Renderizar tab ativo
      if (activeTab === "ETH") { renderAltCoinTab("ETH", altSnapshots["ETH"], altEngines["ETH"]); }
      else if (activeTab === "SOL") { renderAltCoinTab("SOL", altSnapshots["SOL"], altEngines["SOL"]); }
      else if (activeTab === "XRP") { renderAltCoinTab("XRP", altSnapshots["XRP"], altEngines["XRP"]); }
      else if (activeTab === "WEATHER") { renderWeatherTab(); }
      else if (activeTab === "OVERVIEW") { renderOverviewTab(btcSnap); }
      // else: renderiza BTC (código original abaixo)

      const lines = activeTab !== "BTC" ? null : [
        renderTabBar(),
        titleLine,
        marketLine,
        kv("Time left:", `${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`),
        "",
        sepLine(),
        "",
        kv("TA Predict:", predictValue),
        kv("Heiken Ashi:", heikenLine.split(": ")[1] ?? heikenLine),
        kv("RSI:", rsiLine.split(": ")[1] ?? rsiLine),
        kv("MACD:", macdLine.split(": ")[1] ?? macdLine),
        kv("Delta 1/3:", deltaLine.split(": ")[1] ?? deltaLine),
        kv("VWAP:", vwapLine.split(": ")[1] ?? vwapLine),
        "",
        sepLine(),
        "",
        kv("POLYMARKET:", polyHeaderValue),
        liquidity !== null ? kv("Liquidity:", formatNumber(liquidity, 0)) : null,
        settlementLeftMin !== null ? kv("Time left:", `${polyTimeLeftColor}${fmtTimeLeft(settlementLeftMin)}${ANSI.reset}`) : null,
        priceToBeat !== null ? kv("PRICE TO BEAT: ", `$${formatNumber(priceToBeat, 0)}`) : kv("PRICE TO BEAT: ", `${ANSI.gray}-${ANSI.reset}`),
        currentPriceLine,
        "",
        sepLine(),
        "",
        binanceSpotKvLine,
        "",
        sepLine(),
        "",
        kv("ET | Session:", `${ANSI.white}${fmtEtTime(new Date())}${ANSI.reset} | ${ANSI.white}${getBtcSession(new Date())}${ANSI.reset}`),
        "",
        sepLine(),
        centerText(`${ANSI.dim}${ANSI.gray}created by @krajekis${ANSI.reset}`, screenWidth())
      ].filter((x) => x !== null);

      if (lines) renderScreen(lines.join("\n") + "\n");

      evaluateSignals({
          signal: rec.action === "ENTER" ? `ENTER (${rec.side})` : "NO_TRADE",
          marketUp,
          marketDown,
          upTokenId: poly.ok ? poly.tokens?.upTokenId : null,
          downTokenId: poly.ok ? poly.tokens?.downTokenId : null,
          phase: rec.phase,
          side: rec.side,
          reason: rec.reason,
          timeLeftMin,
          bestEdge: rec.bestEdge,
          bestModel: rec.bestModel,
          threshold: rec.threshold,
          minProb: rec.minProb,
          upScore: scored.upScore,
          downScore: scored.downScore,
          regime: regimeInfo.regime
      });

      const altCoinsPayload = {};
      for (const [key, eng] of Object.entries(altEngines)) {
          altCoinsPayload[key] = {
              state: {
                  virtualBalance:  eng.state.virtualBalance,
                  status:          eng.state.status,
                  activePositions: eng.state.activePositions,
                  closedPositions: eng.state.closedPositions.slice(-10),
                  stats:           eng.state.stats,
                  logs:            eng.state.logs.slice(0, 15)
              },
              snapshot: altSnapshots[key] ?? null
          };
      }

      broadcastData({
        timestamp: Date.now(),
        timeLeftMin,
        rsiNow,
        vwapNow,
        vwapDist,
        modelUp: timeAware.adjustedUp,
        modelDown: timeAware.adjustedDown,
        marketUp,
        marketDown,
        signal: rec.action,
        phase: rec.phase,
        engine: {
          virtualBalance:   engineState.virtualBalance,
          status:           engineState.status,
          openPosition:     engineState.openPosition,
          activePositions:  engineState.activePositions,
          closedPositions:  engineState.closedPositions.slice(-20),
          stats:            engineState.stats,
          logs:             engineState.logs.slice(0, 20)
        },
        altCoins: altCoinsPayload,
        weather: weatherState,
        weatherEngine: {
          virtualBalance:  weatherEngineState.virtualBalance,
          status:          weatherEngineState.status,
          activePositions: weatherEngineState.activePositions,
          closedPositions: weatherEngineState.closedPositions.slice(-20),
          stats:           weatherEngineState.stats,
          logs:            weatherEngineState.logs.slice(0, 20)
        },
        config: {
          timeframe: CONFIG.candleWindowMinutes,
          stopWin:   CONFIG.stopWin,
          stopLoss:  CONFIG.stopLoss,
          stake:     CONFIG.stakeAmount,
          dryRun:    CONFIG.dryRun
        }
      });

      prevSpotPrice = spotPrice ?? prevSpotPrice;
      prevCurrentPrice = currentPrice ?? prevCurrentPrice;

      appendCsvRow("./logs/signals.csv", header, [
        new Date().toISOString(),
        timing.elapsedMinutes.toFixed(3),
        timeLeftMin.toFixed(3),
        regimeInfo.regime,
        signal,
        timeAware.adjustedUp,
        timeAware.adjustedDown,
        marketUp,
        marketDown,
        edge.edgeUp,
        edge.edgeDown,
        rec.action === "ENTER" ? `${rec.side}:${rec.phase}:${rec.strength}` : "NO_TRADE"
      ]);
    } catch (err) {
      console.log("────────────────────────────");
      console.log(`Error: ${err?.message ?? String(err)}`);
      console.log("────────────────────────────");
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

main();
