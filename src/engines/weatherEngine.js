import { CONFIG } from "../config.js";
import { clobClient } from "./executor.js";

// ─── Mapa de séries Polymarket de temperatura → coordenadas ──────────────────
// Cada entrada mapeia o seriesId para lat/lon usados nas previsões
const WEATHER_SERIES = {
    "10005": { lat: 40.7128, lon: -74.0060, label: "New York City" },
    "10006": { lat: 51.5074, lon: -0.1278,  label: "London" },
    "10115": { lat: 25.2048, lon: 55.2708,  label: "Dubai" },
    "11168": { lat: 48.8566, lon:  2.3522,  label: "Paris" },
    "10726": { lat: 41.8781, lon: -87.6298, label: "Chicago" },
    "10740": { lat: 35.6762, lon: 139.6503, label: "Tokyo" },
    "10742": { lat: 37.5665, lon: 126.9780, label: "Seoul" },
    "10741": { lat: 31.2304, lon: 121.4737, label: "Shanghai" },
    "10743": { lat: 43.6532, lon: -79.3832, label: "Toronto" },
    "10744": { lat: -34.6037, lon: -58.3816, label: "Buenos Aires" },
    "10727": { lat: 32.7767, lon: -96.7970, label: "Dallas" },
    "10728": { lat: 25.7617, lon: -80.1918, label: "Miami" },
    "10729": { lat: 33.4484, lon: -112.0740, label: "Phoenix" },
    "10730": { lat: 39.7392, lon: -104.9903, label: "Denver" },
    "10734": { lat: 47.6062, lon: -122.3321, label: "Seattle" },
    "10735": { lat: 42.3601, lon:  -71.0589, label: "Boston" },
    "10736": { lat: 44.9778, lon:  -93.2650, label: "Minneapolis" },
    "10739": { lat: 33.7490, lon:  -84.3880, label: "Atlanta" },
    "10900": { lat: 39.9334, lon:   32.8597, label: "Ankara" },
    "10901": { lat: -36.8485, lon: 174.7633, label: "Auckland" },
    "10902": { lat: -41.2866, lon: 174.7756, label: "Wellington" },
    "11169": { lat: -23.5505, lon: -46.6333, label: "São Paulo" },
    "11271": { lat: 26.8467, lon:  80.9462, label: "Lucknow" },
    "11272": { lat: 48.1351, lon:  11.5820, label: "Munich" },
    "11295": { lat: 32.0853, lon:  34.7818, label: "Tel Aviv" },
    "11312": { lat: 22.3193, lon: 114.1694, label: "Hong Kong" },
    "11314": { lat:  1.3521, lon: 103.8198, label: "Singapore" },
    "11342": { lat: 52.2297, lon:  21.0122, label: "Warsaw" },
    "11343": { lat: 45.4642, lon:   9.1900, label: "Milan" },
    "11345": { lat: 40.4168, lon:  -3.7038, label: "Madrid" },
    "11346": { lat: 25.0330, lon: 121.5654, label: "Taipei" },
    "11362": { lat: 29.5630, lon: 106.5516, label: "Chongqing" },
    "11363": { lat: 39.9042, lon: 116.4074, label: "Beijing" },
    "11364": { lat: 30.5928, lon: 114.3055, label: "Wuhan" },
    "11365": { lat: 30.5728, lon: 104.0668, label: "Chengdu" },
    "11366": { lat: 22.5431, lon: 114.0579, label: "Shenzhen" },
    "11367": { lat: 30.2672, lon: -97.7431, label: "Austin" },
    "11369": { lat: 29.7604, lon: -95.3698, label: "Houston" },
    "11370": { lat: 34.0522, lon: -118.2437, label: "Los Angeles" },
    "11371": { lat: 37.7749, lon: -122.4194, label: "San Francisco" },
    "11426": { lat: 55.7558, lon:  37.6173, label: "Moscow" },
    "11427": { lat: 41.0082, lon:  28.9784, label: "Istanbul" },
    "11428": { lat: 19.4284, lon: -99.1276,  label: "Mexico City" },
    "11506": { lat: 35.1028, lon: 129.0403, label: "Busan" },
    "11507": { lat: 52.3676, lon:   4.9041, label: "Amsterdam" },
    "11508": { lat: 60.1699, lon:  24.9384, label: "Helsinki" },
    "11509": { lat:  8.9824, lon: -79.5199, label: "Panama City" },
    "11510": { lat:  3.1390, lon: 101.6869, label: "Kuala Lumpur" },
    "11511": { lat: -6.2088, lon: 106.8456, label: "Jakarta" },
    "11514": { lat: 21.4858, lon:  39.1925, label: "Jeddah" },
    "11515": { lat:  6.5244, lon:   3.3792, label: "Lagos" },
    "11516": { lat: -33.9249, lon:  18.4241, label: "Cape Town" },
};

const MONTHS = {
    january:0, february:1, march:2, april:3, may:4, june:5,
    july:6, august:7, september:8, october:9, november:10, december:11
};

// ─── Estado dos motores ───────────────────────────────────────────────────────
export const weatherEngineState = {
    virtualBalance: 0,
    status: CONFIG.dryRun ? "RUNNING" : "STOPPED",
    logs: [],
    activePositions: [],
    closedPositions: [],
    stats: { predictions: 0, wins: 0, losses: 0 }
};

export const weatherState = {
    analyzing: false,
    marketsMonitored: 0,
    matchesFound: [],
    scanLogs: [],
    lastExecution: "Aguardando 1º pulso..."
};

export function logWeatherEvent(msg) {
    const time = new Date().toLocaleTimeString();
    weatherEngineState.logs.unshift(`[${time}] ${msg}`);
    if (weatherEngineState.logs.length > 100) weatherEngineState.logs.pop();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fToC(f) { return (f - 32) * 5 / 9; }

function parseTitleDate(dateStr) {
    // Suporta "April 8" e "April 8, 2026"
    const m = dateStr.match(/([A-Za-z]+)\s+(\d{1,2})/);
    if (!m) return null;
    const monthIdx = MONTHS[m[1].toLowerCase()];
    const day = parseInt(m[2]);
    if (monthIdx === undefined || isNaN(day)) return null;

    const now = new Date();
    let target = new Date(now.getFullYear(), monthIdx, day);
    // Se a data passou há mais de 1 dia, tenta o próximo ano
    if ((now - target) > 36 * 3600_000) {
        target = new Date(now.getFullYear() + 1, monthIdx, day);
    }
    const daysAhead = Math.round((target - now) / 86_400_000);
    return { date: target, daysAhead };
}

/**
 * Extrai threshold, unidade, operador e data de uma pergunta de mercado.
 * Não precisa extrair o nome da cidade — esse vem do seriesId.
 *
 * Formatos suportados:
 *   "...be 37°F or below on April 8?"
 *   "...be 15°C or above on April 9?"
 *   "...be between 38-39°F on April 8?"
 *   "...be 68°F on April 10?" (exato — raramente usado)
 */
function parseThreshold(question) {
    let m;

    // Range "between X-Y°F/C"
    m = question.match(/be between (\d+)[–\-](\d+)°([CF]) on ([A-Za-z]+ \d+)/i);
    if (m) {
        const [, lo, hi, unit, dateStr] = m;
        const midRaw = (parseFloat(lo) + parseFloat(hi)) / 2;
        const targetC = unit.toUpperCase() === "F" ? fToC(midRaw) : midRaw;
        const loC = unit.toUpperCase() === "F" ? fToC(parseFloat(lo)) : parseFloat(lo);
        const hiC = unit.toUpperCase() === "F" ? fToC(parseFloat(hi)) : parseFloat(hi);
        const dateInfo = parseTitleDate(dateStr);
        if (!dateInfo) return null;
        return { targetC, loC, hiC, unit: unit.toUpperCase(), operator: "between",
                 dateStr, rawDisplay: `${lo}-${hi}°${unit}`, dateInfo };
    }

    // "or below"
    m = question.match(/be (\d+)°([CF]) or below on ([A-Za-z]+ \d+)/i);
    if (m) {
        const [, val, unit, dateStr] = m;
        const targetC = unit.toUpperCase() === "F" ? fToC(parseFloat(val)) : parseFloat(val);
        const dateInfo = parseTitleDate(dateStr);
        if (!dateInfo) return null;
        return { targetC, unit: unit.toUpperCase(), operator: "or_below",
                 dateStr, rawDisplay: `${val}°${unit}`, dateInfo };
    }

    // "or above"
    m = question.match(/be (\d+)°([CF]) or above on ([A-Za-z]+ \d+)/i);
    if (m) {
        const [, val, unit, dateStr] = m;
        const targetC = unit.toUpperCase() === "F" ? fToC(parseFloat(val)) : parseFloat(val);
        const dateInfo = parseTitleDate(dateStr);
        if (!dateInfo) return null;
        return { targetC, unit: unit.toUpperCase(), operator: "or_above",
                 dateStr, rawDisplay: `${val}°${unit}`, dateInfo };
    }

    // Exato
    m = question.match(/be (\d+)°([CF]) on ([A-Za-z]+ \d+)/i);
    if (m) {
        const [, val, unit, dateStr] = m;
        const targetC = unit.toUpperCase() === "F" ? fToC(parseFloat(val)) : parseFloat(val);
        const dateInfo = parseTitleDate(dateStr);
        if (!dateInfo) return null;
        return { targetC, unit: unit.toUpperCase(), operator: "exact",
                 dateStr, rawDisplay: `${val}°${unit}`, dateInfo };
    }

    return null;
}

// ─── Modelo de probabilidade ──────────────────────────────────────────────────
function modelProbYes(forecastMax, parsed, daysAhead) {
    const { targetC, loC, hiC, operator } = parsed;
    const uncertainty = 1 + daysAhead * 0.4; // 1.0 hoje, +0.4 por dia

    if (operator === "or_below") {
        // YES = temp ≤ target
        const gap = forecastMax - targetC; // + = forecast acima do target → tende ao NO
        if (gap > 8 * uncertainty)  return 0.03;
        if (gap > 5 * uncertainty)  return 0.08;
        if (gap > 3 * uncertainty)  return 0.18;
        if (gap > 1 * uncertainty)  return 0.32;
        if (gap > -1 * uncertainty) return 0.50;
        if (gap > -3 * uncertainty) return 0.70;
        return 0.87;
    }

    if (operator === "or_above") {
        // YES = temp ≥ target
        const gap = targetC - forecastMax; // + = target acima do forecast → tende ao NO
        if (gap > 8 * uncertainty)  return 0.03;
        if (gap > 5 * uncertainty)  return 0.08;
        if (gap > 3 * uncertainty)  return 0.18;
        if (gap > 1 * uncertainty)  return 0.32;
        if (gap > -1 * uncertainty) return 0.50;
        return 0.70;
    }

    if (operator === "between") {
        // YES = temp ∈ [lo, hi]
        if (forecastMax < loC) {
            const gap = loC - forecastMax;
            if (gap > 6 * uncertainty) return 0.02;
            if (gap > 3 * uncertainty) return 0.10;
            if (gap > 1 * uncertainty) return 0.25;
            return 0.42;
        }
        if (forecastMax > hiC) {
            const gap = forecastMax - hiC;
            if (gap > 6 * uncertainty) return 0.02;
            if (gap > 3 * uncertainty) return 0.10;
            if (gap > 1 * uncertainty) return 0.25;
            return 0.42;
        }
        return 0.55; // forecast está dentro da faixa → YES provável
    }

    // "exact"
    const dist = Math.abs(forecastMax - targetC);
    if (dist < 0.5) return 0.30;
    if (dist < 1.5) return 0.12;
    return 0.04;
}

function confidenceLabel(probNo) {
    if (probNo >= 0.92) return "ALTÍSSIMA";
    if (probNo >= 0.82) return "ALTA";
    if (probNo >= 0.70) return "MÉDIA";
    return "BAIXA";
}

// ─── Oráculos meteorológicos ──────────────────────────────────────────────────
async function getOpenMeteoForecast(lat, lon, daysAhead) {
    const days = Math.max(daysAhead + 2, 3);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=${days}`;
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        const maxArr = data.daily?.temperature_2m_max;
        const minArr = data.daily?.temperature_2m_min;
        if (!Array.isArray(maxArr) || daysAhead >= maxArr.length) return null;
        return { maxC: maxArr[daysAhead] ?? null, minC: minArr?.[daysAhead] ?? null };
    } catch { return null; }
}

// ─── Busca mercados via series IDs ────────────────────────────────────────────
async function fetchMarketsFromAllSeries() {
    const seriesIds = Object.keys(WEATHER_SERIES);
    const allMarkets = []; // [{market, seriesId}]

    // Buscar em paralelo, em grupos de 10 para não sobrecarregar
    const BATCH = 10;
    for (let i = 0; i < seriesIds.length; i += BATCH) {
        const batch = seriesIds.slice(i, i + BATCH);
        const results = await Promise.allSettled(batch.map(async seriesId => {
            const url = `${CONFIG.gammaBaseUrl}/events?series_id=${seriesId}&active=true&closed=false&limit=10`;
            const res = await fetch(url);
            if (!res.ok) return [];
            const events = await res.json();
            if (!Array.isArray(events)) return [];
            const markets = [];
            for (const ev of events) {
                for (const m of (ev.markets || [])) {
                    markets.push({ market: m, seriesId });
                }
            }
            return markets;
        }));

        for (const r of results) {
            if (r.status === "fulfilled") allMarkets.push(...r.value);
        }
    }

    return allMarkets;
}

async function fetchNoPriceForMarket(market) {
    try {
        const outcomes = Array.isArray(market.outcomes)
            ? market.outcomes
            : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
        const clobTokenIds = Array.isArray(market.clobTokenIds)
            ? market.clobTokenIds
            : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);
        const outcomePrices = Array.isArray(market.outcomePrices)
            ? market.outcomePrices
            : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);

        // Detectar índice do "No" outcome (pode ser "No" ou "N")
        const noIndex = outcomes.findIndex(o => String(o).toLowerCase().startsWith("n"));
        const idx = noIndex >= 0 ? noIndex : 1;
        const noTokenId   = clobTokenIds[idx]    ? String(clobTokenIds[idx])    : null;
        const gammaNoPrice = outcomePrices[idx] != null ? Number(outcomePrices[idx]) : null;

        if (!noTokenId) return { tokenId: null, price: gammaNoPrice };

        const url = new URL("/price", CONFIG.clobBaseUrl);
        url.searchParams.set("token_id", noTokenId);
        url.searchParams.set("side", "buy");
        const res = await fetch(url);
        if (!res.ok) return { tokenId: noTokenId, price: gammaNoPrice };
        const body = await res.json();
        const clobPrice = Number(body.price);
        return { tokenId: noTokenId, price: isFinite(clobPrice) ? clobPrice : gammaNoPrice };
    } catch {
        return { tokenId: null, price: null };
    }
}

// ─── Execução de apostas ──────────────────────────────────────────────────────
export async function executeWeatherSignals(matches) {
    if (weatherEngineState.status !== "RUNNING") return;
    if (!Array.isArray(matches) || matches.length === 0) return;

    for (const match of matches) {
        // Evitar entradas duplicadas no mesmo mercado
        const alreadyOpen = weatherEngineState.activePositions.some(
            p => p.marketId === match.id
        );
        if (alreadyOpen) continue;

        const { tokenId, price: noPrice } = await fetchNoPriceForMarket(match.market);
        const priceDecimal = noPrice !== null ? noPrice : 0.85;

        // Edge real: só entra se mercado ainda não precificou totalmente o NO
        const edge = match.probNo - priceDecimal;
        if (edge < 0.05 && priceDecimal > 0.90) {
            logWeatherEvent(
                `⏭️ [${match.city}] Sem edge real (probNO=${(match.probNo*100).toFixed(0)}% vs mkt=${(priceDecimal*100).toFixed(1)}¢) — pulando`
            );
            continue;
        }

        const sizeShares = CONFIG.stakeAmount / priceDecimal;

        const position = {
            id:           Date.now().toString() + Math.random().toString(36).slice(2),
            marketId:     match.id,
            title:        match.title,
            city:         match.city,
            side:         "NO",
            targetC:      match.targetC,
            operator:     match.operator,
            daysAhead:    match.daysAhead,
            dateStr:      match.dateStr,
            forecastMax:  match.forecastMax,
            probNo:       match.probNo,
            confidence:   match.confidence,
            entryPrice:   priceDecimal,
            currentPrice: priceDecimal,
            shares:       sizeShares,
            stake:        CONFIG.stakeAmount,
            time:         Date.now(),
            status:       "OPEN"
        };

        weatherEngineState.activePositions.push(position);
        weatherEngineState.stats.predictions++;

        logWeatherEvent(
            `🌡️ [ENTRADA NO] ${match.city} | ${match.operator} ${match.rawDisplay} | ` +
            `Data: ${match.dateStr} | Forecast: ${match.forecastMax.toFixed(1)}°C | ` +
            `ProbNO: ${(match.probNo*100).toFixed(0)}% | Preço: ${(priceDecimal*100).toFixed(1)}¢ | ` +
            `Edge: +${(edge*100).toFixed(1)}% | ${match.confidence}${CONFIG.dryRun ? " [DRY]" : ""}`
        );

        if (!CONFIG.dryRun && clobClient && tokenId) {
            logWeatherEvent(`⚡ [REAL] Enviando ordem NO para ${match.city} / ${match.dateStr}...`);
            clobClient.createOrder({
                tokenID: tokenId,
                price: priceDecimal,
                side: "BUY",
                size: sizeShares,
                feeRateBps: 0
            }).then(resp => {
                logWeatherEvent(`✅ Ordem executada: ${resp.orderID || "OK"}`);
            }).catch(e => {
                logWeatherEvent(`❌ Erro L2: ${e.message.slice(0, 60)}`);
            });
        }
    }
}

// ─── Sweep principal ──────────────────────────────────────────────────────────
export async function runWeatherConsensusSweep() {
    if (weatherState.analyzing) return weatherState.matchesFound;
    weatherState.analyzing = true;
    weatherState.scanLogs  = [];
    weatherState.scanLogs.push(`📡 Varredura iniciada — ${new Date().toLocaleTimeString()}`);

    try {
        const allMarketEntries = await fetchMarketsFromAllSeries();
        weatherState.marketsMonitored = allMarketEntries.length;
        weatherState.scanLogs.push(`☁️ ${allMarketEntries.length} mercados de temperatura carregados (${Object.keys(WEATHER_SERIES).length} séries)`);

        if (allMarketEntries.length === 0) {
            weatherState.scanLogs.push(`⚠️ Nenhum mercado encontrado. Retry em 5min.`);
            weatherState.analyzing = false;
            weatherState.lastExecution = new Date().toLocaleTimeString();
            weatherState.matchesFound = [];
            return [];
        }

        const nowMs = Date.now();

        const resultsPromises = allMarketEntries.map(async ({ market, seriesId }) => {
            const question = market.question || market.title || "";
            const parsed = parseThreshold(question);
            if (!parsed) return null;

            const { dateInfo, dateStr, operator, targetC, rawDisplay } = parsed;
            const { daysAhead } = dateInfo;

            if (daysAhead < 0) return null;
            if (daysAhead > 7) return null; // incerteza muito alta

            // Verificar se o mercado ainda está ativo
            const endMs = market.endDate ? new Date(market.endDate).getTime() : null;
            if (endMs && endMs <= nowMs) return null;

            const series = WEATHER_SERIES[seriesId];
            if (!series) return null;

            const { lat, lon, label: city } = series;

            weatherState.scanLogs.push(
                `🔍 [${city}] ${dateStr} (D+${daysAhead}) | ${rawDisplay} (${operator})`
            );

            // Obter previsão meteorológica
            const meteo = await getOpenMeteoForecast(lat, lon, daysAhead);
            const meteoStr = meteo?.maxC != null ? `${meteo.maxC.toFixed(1)}°C` : "OFFLINE";
            weatherState.scanLogs.push(`   └─ Previsão: ${meteoStr}`);

            if (!meteo || meteo.maxC == null) {
                weatherState.scanLogs.push(`⚠️ [${city}] Previsão offline — pulando`);
                return null;
            }

            const forecastMax = meteo.maxC;
            const probYes = modelProbYes(forecastMax, parsed, daysAhead);
            const probNo  = 1 - probYes;

            if (probNo < 0.82) {
                // Silencioso para manter logs compactos (muitas cidades)
                return null;
            }

            const confidence = confidenceLabel(probNo);
            weatherState.scanLogs.push(
                `✅ [${city}] SINAL NO | Forecast: ${forecastMax.toFixed(1)}°C | ` +
                `${rawDisplay} (${operator}) | ProbNO: ${(probNo*100).toFixed(0)}% | ${confidence}`
            );

            return {
                id:         market.id || market.conditionId || market.slug,
                title:      question,
                city,
                seriesId,
                targetC,
                loC:        parsed.loC,
                hiC:        parsed.hiC,
                operator,
                rawDisplay,
                dateStr,
                daysAhead,
                forecastMax,
                probNo,
                confidence,
                market
            };
        });

        const rawResults = await Promise.all(resultsPromises);
        // Ordenar por maior probNo, manter top 30 (limita chamadas CLOB)
        const allMatches = rawResults
            .filter(r => r !== null)
            .sort((a, b) => b.probNo - a.probNo)
            .slice(0, 30);

        weatherState.matchesFound = allMatches;
        weatherState.lastExecution = new Date().toLocaleTimeString();

        const total = weatherState.matchesFound.length;
        if (total > 0) {
            weatherState.scanLogs.push(`🎯 ${total} oportunidade(s) encontrada(s)!`);
            logWeatherEvent(`🌍 Varredura concluída — ${total} sinal(is) disponível(is)`);
        } else {
            weatherState.scanLogs.push(`📭 Nenhuma oportunidade no momento`);
            logWeatherEvent(`🌍 Varredura concluída — sem sinais ativos`);
        }

    } catch (e) {
        const msg = `❌ Erro na varredura: ${e.message}`;
        weatherState.scanLogs.push(msg);
        logWeatherEvent(msg);
    }

    weatherState.analyzing = false;
    return weatherState.matchesFound;
}
