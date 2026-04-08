/**
 * Factory de engine por moeda.
 * ETH, SOL, XRP usam esta factory.
 * BTC mantém executor.js existente (backward compat).
 */

import { CONFIG }                                          from "../config.js";
import { recordClosedTrade, appendTradeLog, loadPortfolio } from "../data/persistence.js";

function fmt(v, d = 3) { return v !== null && v !== undefined ? Number(v).toFixed(d) : "--"; }
function pct(v)        { return v !== null && v !== undefined ? `${(v * 100).toFixed(1)}%` : "--"; }
function gap(val, min) {
    if (val === null || val === undefined || min === null) return "";
    const diff = val - min;
    return diff >= 0 ? ` ✓(+${pct(diff)})` : ` ✗(faltou ${pct(Math.abs(diff))})`;
}

export function createCoinEngine(coinKey, portfolio) {
    // Restaurar estado salvo
    const saved = portfolio?.engines?.[coinKey];

    const state = {
        name:             coinKey,
        virtualBalance:   saved?.virtualBalance   ?? 0,
        openPosition:     null,   // posições abertas nunca persistem (precisaria de execução real)
        status:           CONFIG.dryRun ? "RUNNING" : "STOPPED",
        logs:             [],
        activePositions:  [],
        closedPositions:  [],     // sessão atual (in-memory)
        stats: {
            predictions:  saved?.stats?.predictions ?? 0,
            wins:         saved?.stats?.wins        ?? 0,
            losses:       saved?.stats?.losses      ?? 0,
            biggestWin:   saved?.stats?.biggestWin  ?? 0,
            positionsValue: 0
        }
    };

    let scanTick = 0;
    // Referência ao portfolio para persistência (mutable)
    let _portfolio = portfolio ?? loadPortfolio();

    function logEvent(msg) {
        const time = new Date().toLocaleTimeString();
        state.logs.unshift(`[${time}] ${msg}`);
        if (state.logs.length > 100) state.logs.pop();
    }

    function evaluateSignals(data) {
        if (state.status !== "RUNNING") return;
        scanTick++;

        // Guards de stop
        if (state.virtualBalance <= -CONFIG.stopLoss) {
            logEvent(`🛑 STOP LOSS [${coinKey}] (Bal: $${state.virtualBalance.toFixed(2)})`);
            state.status = "STOPPED";
            return;
        }
        if (state.virtualBalance >= CONFIG.stopWin) {
            logEvent(`🎯 STOP WIN [${coinKey}] (Bal: $${state.virtualBalance.toFixed(2)})`);
            state.status = "STOPPED";
            return;
        }

        // Entrada
        if (!state.openPosition && data.signal && data.signal.includes("ENTER")) {
            const side     = data.signal.includes("UP") ? "UP" : "DOWN";
            const price    = side === "UP" ? data.marketUp : data.marketDown;
            const tokenId  = side === "UP" ? data.upTokenId : data.downTokenId;

            if (!price || price <= 0) {
                logEvent(`⚠️ [${coinKey}] Sinal ignorado: preço nulo`);
                return;
            }

            const priceDecimal = price;
            const sizeShares   = CONFIG.stakeAmount / priceDecimal;

            const position = {
                id:           Date.now().toString(),
                market:       `${coinKey} 15m - ${side}`,
                side,
                entryPrice:   priceDecimal,
                currentPrice: priceDecimal,
                shares:       sizeShares,
                time:         Date.now()
            };

            state.openPosition = position;
            state.activePositions.push(position);
            state.stats.predictions++;

            logEvent(`🛒 [${coinKey}] ENTRADA ${side} a ${(price * 100).toFixed(1)}¢ | ${sizeShares.toFixed(2)} shares | Stake: $${CONFIG.stakeAmount}${CONFIG.dryRun ? " [DRY]" : ""}`);

        } else if (scanTick % 10 === 0) {
            // Log de rastreabilidade a cada 10s
            const tempo = data.timeLeftMin !== undefined ? `${Number(data.timeLeftMin).toFixed(1)}m` : "--";
            const fase  = data.phase || "ANALYSIS";
            const lado  = data.side  || "?";

            if (data.reason === "missing_market_data") {
                logEvent(`🔎 [${coinKey} | ${fase} | ${tempo}] Sem dados de mercado Polymarket`);
            } else if (data.reason?.includes("edge_below")) {
                logEvent(`🔎 [${coinKey} | ${fase} | ${tempo}] ${lado} | Edge: ${fmt(data.bestEdge, 4)}${gap(data.bestEdge, data.threshold)} — edge insuficiente`);
            } else if (data.reason?.includes("prob_below")) {
                logEvent(`🔎 [${coinKey} | ${fase} | ${tempo}] ${lado} | Edge: ${fmt(data.bestEdge, 4)} ✓ | Model: ${pct(data.bestModel)}${gap(data.bestModel, data.minProb)} — convicção baixa`);
            }

            if (scanTick % 30 === 0 && data.upScore !== undefined) {
                logEvent(`📊 [${coinKey} | ${data.regime || '-'}] UP: ${data.upScore}pts | DOWN: ${data.downScore}pts | mkt: ↑${pct(data.marketUp)} ↓${pct(data.marketDown)}`);
            }
        }

        // Gerenciamento de posição aberta
        if (state.openPosition) {
            const px = state.openPosition.side === "UP" ? data.marketUp : data.marketDown;
            if (px) {
                const activeRef = state.activePositions.find(p => p.id === state.openPosition.id);
                if (activeRef) {
                    activeRef.currentPrice = px;
                    state.stats.positionsValue = activeRef.shares * px;
                }

                const diff = px - state.openPosition.entryPrice;
                if (diff >= 0.05 || diff <= -0.05) {
                    const isWin     = diff > 0;
                    const multiplier = isWin ? 0.3 : -0.3;
                    const pnl       = CONFIG.stakeAmount * multiplier;
                    state.virtualBalance += pnl;

                    if (isWin) {
                        state.stats.wins++;
                        if (pnl > state.stats.biggestWin) state.stats.biggestWin = pnl;
                    } else {
                        state.stats.losses++;
                    }

                    const entryPct = (state.openPosition.entryPrice * 100).toFixed(1);
                    const exitPct  = (px * 100).toFixed(1);
                    const diffPct  = (diff * 100).toFixed(1);
                    logEvent(`✅ [${coinKey}] ${isWin ? "Lucro" : "Loss"} | ${entryPct}¢ → ${exitPct}¢ (${isWin ? "+" : ""}${diffPct}¢) | PnL: $${pnl.toFixed(2)} | Saldo: $${state.virtualBalance.toFixed(2)}`);

                    // Fechar posição e persistir
                    const idx = state.activePositions.findIndex(p => p.id === state.openPosition.id);
                    let closedPos = null;
                    if (idx > -1) {
                        closedPos = state.activePositions.splice(idx, 1)[0];
                        closedPos.pnl        = pnl;
                        closedPos.exitPrice  = px;
                        closedPos.closedAt   = Date.now();
                        state.closedPositions.push(closedPos);
                        state.stats.positionsValue = 0;
                    }
                    state.openPosition = null;

                    // Persistir no arquivo
                    const tradeRecord = {
                        coin:       coinKey,
                        side:       closedPos?.side ?? "?",
                        entryPrice: closedPos?.entryPrice ?? 0,
                        exitPrice:  px,
                        pnl,
                        newBalance: state.virtualBalance,
                        market:     data.market ?? `${coinKey} 15m`,
                        phase:      data.phase
                    };
                    recordClosedTrade(_portfolio, coinKey, tradeRecord);
                    appendTradeLog(coinKey, tradeRecord);
                }
            }
        }
    }

    function setPortfolio(p) { _portfolio = p; }

    function toggleStatus() {
        state.status = state.status === "RUNNING" ? "STOPPED" : "RUNNING";
        logEvent(`Motor ${coinKey}: ${state.status}`);
    }

    return { state, logEvent, evaluateSignals, toggleStatus, setPortfolio };
}
