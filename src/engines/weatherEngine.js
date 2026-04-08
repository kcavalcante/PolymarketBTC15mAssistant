import { CONFIG } from "../config.js";
import { clobClient } from "./executor.js";

// ─── Banco de cidades com coordenadas ────────────────────────────────────────
const CITY_GEO = {
    "Panama City":   { lat: 8.9824,  lon: -79.5199 },
    "Mexico City":   { lat: 19.4284, lon: -99.1276 },
    "Amsterdam":     { lat: 52.3676, lon: 4.9041   },
    "Istanbul":      { lat: 41.0082, lon: 28.9784  },
    "Busan":         { lat: 35.1028, lon: 129.0403 },
    "Milan":         { lat: 45.4642, lon: 9.1900   },
    "Dallas":        { lat: 32.7767, lon: -96.7970 },
    "Madrid":        { lat: 40.4168, lon: -3.7038  },
    "London":        { lat: 51.5074, lon: -0.1278  },
    "Paris":         { lat: 48.8566, lon: 2.3522   },
    "Berlin":        { lat: 52.5200, lon: 13.4050  },
    "Rome":          { lat: 41.9028, lon: 12.4964  },
    "Barcelona":     { lat: 41.3851, lon: 2.1734   },
    "Vienna":        { lat: 48.2082, lon: 16.3738  },
    "Lisbon":        { lat: 38.7223, lon: -9.1393  },
    "Athens":        { lat: 37.9838, lon: 23.7275  },
    "Warsaw":        { lat: 52.2297, lon: 21.0122  },
    "Stockholm":     { lat: 59.3293, lon: 18.0686  },
    "Oslo":          { lat: 59.9139, lon: 10.7522  },
    "Copenhagen":    { lat: 55.6761, lon: 12.5683  },
    "Zurich":        { lat: 47.3769, lon: 8.5417   },
    "Brussels":      { lat: 50.8503, lon: 4.3517   },
    "Prague":        { lat: 50.0755, lon: 14.4378  },
    "Budapest":      { lat: 47.4979, lon: 19.0402  },
    "Helsinki":      { lat: 60.1699, lon: 24.9384  },
    "Bucharest":     { lat: 44.4268, lon: 26.1025  },
    "New York":      { lat: 40.7128, lon: -74.0060 },
    "Los Angeles":   { lat: 34.0522, lon: -118.2437 },
    "Chicago":       { lat: 41.8781, lon: -87.6298 },
    "Houston":       { lat: 29.7604, lon: -95.3698 },
    "Phoenix":       { lat: 33.4484, lon: -112.0740 },
    "Miami":         { lat: 25.7617, lon: -80.1918 },
    "Seattle":       { lat: 47.6062, lon: -122.3321 },
    "Denver":        { lat: 39.7392, lon: -104.9903 },
    "Atlanta":       { lat: 33.7490, lon: -84.3880 },
    "Boston":        { lat: 42.3601, lon: -71.0589 },
    "Las Vegas":     { lat: 36.1699, lon: -115.1398 },
    "Minneapolis":   { lat: 44.9778, lon: -93.2650 },
    "Seoul":         { lat: 37.5665, lon: 126.9780 },
    "Tokyo":         { lat: 35.6762, lon: 139.6503 },
    "Beijing":       { lat: 39.9042, lon: 116.4074 },
    "Shanghai":      { lat: 31.2304, lon: 121.4737 },
    "Hong Kong":     { lat: 22.3193, lon: 114.1694 },
    "Singapore":     { lat: 1.3521,  lon: 103.8198 },
    "Bangkok":       { lat: 13.7563, lon: 100.5018 },
    "Mumbai":        { lat: 19.0760, lon: 72.8777  },
    "Dubai":         { lat: 25.2048, lon: 55.2708  },
    "Jakarta":       { lat: -6.2088, lon: 106.8456 },
    "Manila":        { lat: 14.5995, lon: 120.9842 },
    "Sydney":        { lat: -33.8688, lon: 151.2093 },
    "Melbourne":     { lat: -37.8136, lon: 144.9631 },
    "Cairo":         { lat: 30.0444, lon: 31.2357  },
    "São Paulo":     { lat: -23.5505, lon: -46.6333 },
    "Buenos Aires":  { lat: -34.6037, lon: -58.3816 },
    "Bogota":        { lat: 4.7110,  lon: -74.0721 },
    "Nairobi":       { lat: -1.2921, lon: 36.8219  },
    "Riyadh":        { lat: 24.7136, lon: 46.6753  },
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

// Extrai cidade, target (°C), operador e data de um título de mercado
// Formatos aceitos:
//   "Will the highest temperature in Panama City be 26°C or below on April 7?"
//   "Will the highest temperature in Dallas be 69°F or below on April 8?"
//   "Will the highest temperature in Milan be 15°C on April 9?"
function parseMarketTitle(title) {
    const patterns = [
        // Com "or below"
        /highest temperature in ([\w\s]+?) be (\d{1,3})°([CF]) or below on ([A-Za-z]+ \d{1,2})/i,
        // Com "or above"
        /highest temperature in ([\w\s]+?) be (\d{1,3})°([CF]) or above on ([A-Za-z]+ \d{1,2})/i,
        // Apenas data (sem "or below/above") — assume threshold exato
        /highest temperature in ([\w\s]+?) be (\d{1,3})°([CF]) on ([A-Za-z]+ \d{1,2})/i,
        // Sem unidade explícita
        /highest temperature in ([\w\s]+?) be (\d{1,3})° or below on ([A-Za-z]+ \d{1,2})/i,
        /highest temperature in ([\w\s]+?) be (\d{1,3})° on ([A-Za-z]+ \d{1,2})/i,
    ];

    for (let i = 0; i < patterns.length; i++) {
        const m = title.match(patterns[i]);
        if (!m) continue;

        let city, rawTarget, unit, dateStr, operator;

        if (i <= 2) {
            [, city, rawTarget, unit, dateStr] = m;
            operator = i === 0 ? "or_below" : i === 1 ? "or_above" : "exact";
        } else if (i === 3) {
            [, city, rawTarget, dateStr] = m;
            unit = "C";
            operator = "or_below";
        } else {
            [, city, rawTarget, dateStr] = m;
            unit = "C";
            operator = "exact";
        }

        city = city.trim();
        const rawNum = parseFloat(rawTarget);
        // Converter para °C
        const targetC = unit.toUpperCase() === "F" ? fToC(rawNum) : rawNum;

        const dateInfo = parseTitleDate(dateStr.trim());
        if (!dateInfo) continue;

        return { city, targetC, unit: unit.toUpperCase(), rawTarget: rawNum, operator, dateStr, dateInfo };
    }
    return null;
}

function parseTitleDate(dateStr) {
    const m = dateStr.match(/([A-Za-z]+)\s+(\d{1,2})/);
    if (!m) return null;
    const monthIdx = MONTHS[m[1].toLowerCase()];
    const day = parseInt(m[2]);
    if (monthIdx === undefined || isNaN(day)) return null;

    const now = new Date();
    const year = now.getFullYear();
    let target = new Date(year, monthIdx, day);

    // Se a data já passou mais de 1 dia, tenta ano seguinte (ex: Dec em Jan)
    if ((now - target) > 36 * 3600_000) {
        target = new Date(year + 1, monthIdx, day);
    }

    const diffMs = target - now;
    const daysAhead = Math.round(diffMs / 86_400_000);

    return { date: target, daysAhead };
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

async function getWttrForecast(city, daysAhead) {
    // wttr.in oferece apenas 3 dias (0=hoje, 1=amanhã, 2=depois)
    if (daysAhead > 2) return null;
    try {
        const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        const w = data.weather?.[daysAhead];
        if (!w) return null;
        return {
            maxC: Number(w.maxtempC) || null,
            minC: Number(w.mintempC) || null
        };
    } catch { return null; }
}

// ─── Modelo de probabilidade ──────────────────────────────────────────────────

// Retorna probabilidade de YES (temperatura fica no threshold do mercado)
// operator "or_below": YES = temp ≤ target
// operator "or_above": YES = temp ≥ target
// operator "exact":    YES = temp ≈ target (muito improvável → quase sempre NO)
function modelProbYes(forecastMax, targetC, operator, daysAhead) {
    // Incerteza aumenta com dias à frente
    const uncertainty = 1 + daysAhead * 0.4; // 1.0 hoje, 1.4 amanhã, 2.2 em 3 dias

    if (operator === "or_below") {
        const gap = forecastMax - targetC; // positivo = forecast acima do target → NO
        if (gap > 8 * uncertainty)  return 0.03;
        if (gap > 5 * uncertainty)  return 0.08;
        if (gap > 3 * uncertainty)  return 0.18;
        if (gap > 1 * uncertainty)  return 0.32;
        if (gap > -1 * uncertainty) return 0.50;
        if (gap > -3 * uncertainty) return 0.70;
        return 0.87;
    }

    if (operator === "or_above") {
        const gap = targetC - forecastMax; // positivo = target acima do forecast → NO
        if (gap > 8 * uncertainty)  return 0.03;
        if (gap > 5 * uncertainty)  return 0.08;
        if (gap > 3 * uncertainty)  return 0.18;
        if (gap > 1 * uncertainty)  return 0.32;
        if (gap > -1 * uncertainty) return 0.50;
        return 0.70;
    }

    // "exact": YES = temperatura exatamente igual ao valor → quase nunca acontece
    const dist = Math.abs(forecastMax - targetC);
    if (dist < 0.5) return 0.35; // muito próximo, possível
    if (dist < 1.5) return 0.15;
    return 0.05;
}

function confidenceLabel(probNo) {
    if (probNo >= 0.92) return "ALTÍSSIMA";
    if (probNo >= 0.82) return "ALTA";
    if (probNo >= 0.70) return "MÉDIA";
    return "BAIXA";
}

// ─── Busca de mercados no Polymarket ─────────────────────────────────────────

async function fetchAllTemperatureMarkets() {
    const results = [];

    // Estratégia 1: buscar via /markets com question filter (alta especificidade)
    try {
        const url = `${CONFIG.gammaBaseUrl}/markets?active=true&closed=false&limit=500&question=highest+temperature`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data) && data.length > 0) {
                results.push(...data);
            }
        }
    } catch { /* silencioso */ }

    // Estratégia 2: /events com paginação (captura mercados não retornados pelo 1)
    try {
        const url = `${CONFIG.gammaBaseUrl}/events?active=true&closed=false&limit=500`;
        const res = await fetch(url);
        if (res.ok) {
            const events = await res.json();
            if (Array.isArray(events)) {
                for (const ev of events) {
                    const title = ev.title || ev.question || "";
                    if (/highest temperature/i.test(title)) {
                        // Cada evento pode ter vários mercados
                        const markets = Array.isArray(ev.markets) ? ev.markets : [ev];
                        results.push(...markets);
                    }
                }
            }
        }
    } catch { /* silencioso */ }

    // Deduplicar por id
    const seen = new Set();
    return results.filter(m => {
        const id = m.id || m.conditionId || JSON.stringify(m).slice(0, 40);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
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

        const noIndex = outcomes.findIndex(o => String(o).toLowerCase() === "no");
        const idx = noIndex >= 0 ? noIndex : 1;
        const noTokenId = clobTokenIds[idx] ? String(clobTokenIds[idx]) : null;
        const gammaNoPrice = outcomePrices[idx] ? Number(outcomePrices[idx]) : null;

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
        const alreadyOpen = weatherEngineState.activePositions.some(p => p.marketId === match.id);
        if (alreadyOpen) continue;

        const { tokenId, price } = await fetchNoPriceForMarket(match.market || {});
        const priceDecimal = price !== null ? price : 0.90; // fallback conservador
        const sizeShares = CONFIG.stakeAmount / priceDecimal;

        const position = {
            id:           Date.now().toString(),
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

        const targetStr = match.unit === "F"
            ? `${match.rawTarget}°F (${match.targetC.toFixed(1)}°C)`
            : `${match.targetC.toFixed(0)}°C`;

        logWeatherEvent(
            `🌡️ [ENTRADA] ${match.city} | Aposta: NO (${match.operator}) | ` +
            `Threshold: ${targetStr} | Data: ${match.dateStr} | ` +
            `Forecast: ${match.forecastMax.toFixed(1)}°C | Gap: ${(match.forecastMax - match.targetC).toFixed(1)}°C | ` +
            `Confiança: ${match.confidence} | Preço NO: ${(priceDecimal * 100).toFixed(1)}¢ | ` +
            `Stake: $${CONFIG.stakeAmount}${CONFIG.dryRun ? " [DRY-RUN]" : ""}`
        );

        if (!CONFIG.dryRun && clobClient && tokenId) {
            logWeatherEvent(`⚡ [REAL] Enviando ordem NO para ${match.city} / ${match.dateStr}...`);
            clobClient.createOrder({
                tokenID: tokenId,
                price:   priceDecimal,
                side:    "BUY",
                size:    sizeShares,
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
    weatherState.analyzing = true;
    weatherState.scanLogs = [];
    weatherState.scanLogs.push(`📡 [CLIMA] Varredura iniciada — ${new Date().toLocaleTimeString()}`);

    try {
        const allMarkets = await fetchAllTemperatureMarkets();
        weatherState.marketsMonitored = allMarkets.length;
        weatherState.scanLogs.push(`☁️ [CLIMA] ${allMarkets.length} mercados de temperatura encontrados`);

        if (allMarkets.length === 0) {
            weatherState.scanLogs.push(`⚠️ [CLIMA] Nenhum mercado "highest temperature" ativo. Retry em 5min.`);
            weatherState.analyzing = false;
            weatherState.lastExecution = new Date().toLocaleTimeString();
            weatherState.matchesFound = [];
            return [];
        }

        const resultsPromises = allMarkets.map(async (market) => {
            const title = market.question || market.title || "";
            const parsed = parseMarketTitle(title);

            if (!parsed) return null;

            const { city, targetC, unit, rawTarget, operator, dateStr, dateInfo } = parsed;
            const { daysAhead } = dateInfo;

            // Mercado já expirou
            if (daysAhead < 0) return null;
            // Mais de 7 dias à frente: incerteza muito alta
            if (daysAhead > 7) {
                weatherState.scanLogs.push(`⏭️ [${city}] Muito distante (${daysAhead} dias) — ignorando`);
                return null;
            }

            const coords = CITY_GEO[city];
            if (!coords) {
                weatherState.scanLogs.push(`⏭️ [${city}] Sem coordenadas cadastradas`);
                return null;
            }

            weatherState.scanLogs.push(`🔍 [${city}] ${dateStr} (D+${daysAhead}) | Target: ${rawTarget}°${unit} (${operator})`);

            const [meteo, wttr] = await Promise.all([
                getOpenMeteoForecast(coords.lat, coords.lon, daysAhead),
                getWttrForecast(city, daysAhead)
            ]);

            const meteoStr = meteo?.maxC !== null ? `${meteo.maxC.toFixed(1)}°C` : "OFFLINE";
            const wttrStr  = wttr?.maxC  !== null ? `${wttr.maxC.toFixed(1)}°C`  : "—";
            weatherState.scanLogs.push(`   └─ Open-Meteo: ${meteoStr} | wttr.in: ${wttrStr}`);

            if (!meteo || meteo.maxC === null) {
                weatherState.scanLogs.push(`⚠️ [${city}] Open-Meteo offline — pulando`);
                return null;
            }

            // Usar o máximo entre as fontes disponíveis como previsão conservadora
            const forecastMax = wttr?.maxC !== null
                ? Math.max(meteo.maxC, wttr.maxC)
                : meteo.maxC;

            const probYes = modelProbYes(forecastMax, targetC, operator, daysAhead);
            const probNo  = 1 - probYes;

            // Edge mínimo: modelo deve ter ≥ 70% de confiança no NO
            const EDGE_THRESHOLD = 0.70;
            if (probNo < EDGE_THRESHOLD) {
                const reason = probNo >= 0.50
                    ? `Incerto (probNO=${(probNo*100).toFixed(0)}%)`
                    : `Forecast favorece YES (${forecastMax.toFixed(1)}°C vs ${targetC.toFixed(1)}°C)`;
                weatherState.scanLogs.push(`❌ [${city}] ${reason} — SEM ENTRADA`);
                return null;
            }

            const confidence = confidenceLabel(probNo);
            weatherState.scanLogs.push(
                `✅ [${city}] SINAL NO | Forecast: ${forecastMax.toFixed(1)}°C | ` +
                `Target: ${targetC.toFixed(1)}°C | ProbNO: ${(probNo*100).toFixed(0)}% | ${confidence}`
            );

            return {
                id:          market.id || market.conditionId,
                title,
                city,
                targetC,
                unit,
                rawTarget,
                operator,
                dateStr,
                daysAhead,
                forecastMax,
                probNo,
                confidence,
                market
            };
        });

        const rawResults = await Promise.all(resultsPromises);
        weatherState.matchesFound = rawResults.filter(r => r !== null);
        weatherState.lastExecution = new Date().toLocaleTimeString();

        const total = weatherState.matchesFound.length;
        if (total > 0) {
            weatherState.scanLogs.push(`🎯 [CLIMA] ${total} oportunidade(s) encontrada(s)`);
            logWeatherEvent(`🌍 Varredura concluída — ${total} sinal(is) disponível(is)`);
        } else {
            weatherState.scanLogs.push(`📭 [CLIMA] Nenhuma oportunidade no momento`);
        }

    } catch (e) {
        const msg = `❌ [CLIMA] Erro na varredura: ${e.message}`;
        weatherState.scanLogs.push(msg);
        logWeatherEvent(msg);
    }

    weatherState.analyzing = false;
    return weatherState.matchesFound;
}
