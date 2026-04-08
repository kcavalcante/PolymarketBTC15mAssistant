/**
 * Resolver de mercado Polymarket por moeda.
 * Generaliza resolveCurrentBtc15mMarket + fetchPolymarketSnapshot do index.js.
 * Cache per-coin para evitar HTTP excessivo.
 */

import { CONFIG } from "../config.js";
import {
    fetchLiveEventsBySeriesId,
    fetchMarketsBySeriesSlug,
    flattenEventMarkets,
    pickLatestLiveMarket,
    fetchClobPrice,
    fetchOrderBook,
    summarizeOrderBook
} from "./polymarket.js";

function toNumber(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
}

// Cache per-coin: coinKey → { market, fetchedAtMs }
const marketCaches = new Map();

async function resolveMarketForCoin(coin) {
    const cached = marketCaches.get(coin.key);
    const now    = Date.now();

    if (cached && (now - cached.fetchedAtMs) < CONFIG.pollIntervalMs) {
        return cached.market;
    }

    let market = null;

    // 1. Tentar via seriesId (mais rápido, BTC tem isso)
    if (coin.polymarket.seriesId) {
        try {
            const events  = await fetchLiveEventsBySeriesId({ seriesId: coin.polymarket.seriesId, limit: 25 });
            const markets = flattenEventMarkets(events);
            market = pickLatestLiveMarket(markets);
        } catch { /* silencioso */ }
    }

    // 2. Tentar via slugCandidates
    if (!market) {
        for (const slug of (coin.polymarket.slugCandidates ?? [])) {
            try {
                const markets = await fetchMarketsBySeriesSlug({ seriesSlug: slug, limit: 10 });
                const picked  = pickLatestLiveMarket(markets);
                if (picked) { market = picked; break; }
            } catch { /* silencioso */ }
        }
    }

    marketCaches.set(coin.key, { market, fetchedAtMs: now });
    return market;
}

export async function fetchPolymarketSnapshotForCoin(coin) {
    const market = await resolveMarketForCoin(coin);
    if (!market) return { ok: false, reason: "no_market" };

    const outcomes = Array.isArray(market.outcomes)
        ? market.outcomes
        : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
    const outcomePrices = Array.isArray(market.outcomePrices)
        ? market.outcomePrices
        : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);
    const clobTokenIds = Array.isArray(market.clobTokenIds)
        ? market.clobTokenIds
        : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

    const upLabel   = coin.polymarket.upOutcomeLabel.toLowerCase();
    const downLabel = coin.polymarket.downOutcomeLabel.toLowerCase();

    let upTokenId   = null;
    let downTokenId = null;
    for (let i = 0; i < outcomes.length; i++) {
        const label   = String(outcomes[i]).toLowerCase();
        const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
        if (!tokenId) continue;
        if (label === upLabel)   upTokenId   = tokenId;
        if (label === downLabel) downTokenId = tokenId;
    }

    const upIndex   = outcomes.findIndex(x => String(x).toLowerCase() === upLabel);
    const downIndex = outcomes.findIndex(x => String(x).toLowerCase() === downLabel);
    const gammaUp   = upIndex   >= 0 ? toNumber(outcomePrices[upIndex])   : null;
    const gammaDown = downIndex >= 0 ? toNumber(outcomePrices[downIndex]) : null;

    if (!upTokenId || !downTokenId) {
        return { ok: false, reason: "missing_token_ids", market };
    }

    let upBuy   = null;
    let downBuy = null;
    let upBook   = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
    let downBook = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };

    try {
        const [yB, nB, ubk, dbk] = await Promise.all([
            fetchClobPrice({ tokenId: upTokenId,   side: "buy" }),
            fetchClobPrice({ tokenId: downTokenId, side: "buy" }),
            fetchOrderBook({ tokenId: upTokenId   }),
            fetchOrderBook({ tokenId: downTokenId })
        ]);
        upBuy   = yB;
        downBuy = nB;
        upBook   = summarizeOrderBook(ubk);
        downBook = summarizeOrderBook(dbk);
    } catch { /* usa preços gamma como fallback */ }

    return {
        ok:      true,
        market,
        tokens:  { upTokenId, downTokenId },
        prices:  { up: upBuy ?? gammaUp, down: downBuy ?? gammaDown },
        orderbook: { up: upBook, down: downBook }
    };
}
