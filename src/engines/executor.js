import { CONFIG } from "../config.js";
import { recordClosedTrade, appendTradeLog } from "../data/persistence.js";

// Portfolio é injetado por index.js após o carregamento (evita circular dependency)
let _portfolio = null;
export function setExecutorPortfolio(p) { _portfolio = p; }
import { ClobClient } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

export let clobClient = null;
try {
    if (!CONFIG.dryRun && CONFIG.walletPrivateKey !== "mock-private-key") {
        let pk = CONFIG.walletPrivateKey;
        if (!pk.startsWith("0x")) pk = "0x" + pk;
        
        const account = privateKeyToAccount(pk);
        const walletClient = createWalletClient({
            account,
            chain: polygon,
            transport: http(),
        });
        
        const creds = (CONFIG.clobApiKey && CONFIG.clobApiKey !== "undefined" && !CONFIG.clobApiKey.includes("aqui")) ? {
              key: CONFIG.clobApiKey,
              secret: CONFIG.clobSecret,
              passphrase: CONFIG.clobPassphrase,
        } : undefined;

        clobClient = new ClobClient(
            CONFIG.clobBaseUrl,
            137,
            walletClient,
            creds
        );
        console.log("⚡ Clob Client L2 Inicializado para REAL MONEY Operation!");
    }
} catch (error) {
    console.error("Falha ao inicializar ClobClient:", error.message);
}

export const engineState = {
    virtualBalance: 0,
    openPosition: null, // BTC open position (legacy ref)
    status: CONFIG.dryRun ? "RUNNING" : "STOPPED",
    logs: [],
    activePositions: [], // Unified positions for UI Table
    closedPositions: [],
    stats: {
        positionsValue: 0,
        biggestWin: 0,
        predictions: 0
    }
};

export function logEvent(msg) {
    const time = new Date().toLocaleTimeString();
    engineState.logs.unshift(`[${time}] ${msg}`);
    if (engineState.logs.length > 100) engineState.logs.pop();
}

function fmt(v, d = 3) { return v !== null && v !== undefined ? Number(v).toFixed(d) : "--"; }
function pct(v) { return v !== null && v !== undefined ? `${(v * 100).toFixed(1)}%` : "--"; }
function gap(val, min) {
    if (val === null || val === undefined || min === null) return "";
    const diff = val - min;
    return diff >= 0 ? ` ✓(+${pct(diff)})` : ` ✗(faltou ${pct(Math.abs(diff))})`;
}

let _scanTick = 0;

export function evaluateSignals(data) {
    if (engineState.status !== "RUNNING") return;
    _scanTick++;

    // Stop Loss / Win Guards
    if (engineState.virtualBalance <= -CONFIG.stopLoss) {
        logEvent(`🛑 STOP LOSS Atingido! (Bal: $${engineState.virtualBalance.toFixed(2)}) Motor travado.`);
        engineState.status = "STOPPED";
        return;
    }
    if (engineState.virtualBalance >= CONFIG.stopWin) {
        logEvent(`🎯 STOP WIN Atingido! (Bal: $${engineState.virtualBalance.toFixed(2)}) Motor travado.`);
        engineState.status = "STOPPED";
        return;
    }

    // Gatilho de Compra em Paper Trading Mode
    if (!engineState.openPosition && data.signal.includes("ENTER")) {
        const side = data.signal.includes("UP") ? "UP" : "DOWN";
        const price = side === "UP" ? data.marketUp : data.marketDown;
        const tokenId = side === "UP" ? data.upTokenId : data.downTokenId;
        
        if (!price || price <= 0) {
            logEvent(`⚠️ SINAL Ignorado: Preço nulo na ordem de compra.`);
            return; 
        }
        
        // price já vem em decimal (0-1) do Polymarket — ex: 0.40 = 40¢
        const priceDecimal = price;
        const sizeShares = CONFIG.stakeAmount / priceDecimal;

        const positionData = {
            id: Date.now().toString(),
            market: `Bitcoin 15m Momentum - ${side}`,
            side: side,
            entryPrice: priceDecimal,
            currentPrice: priceDecimal,
            shares: sizeShares,
            time: Date.now()
        };
        engineState.openPosition = positionData;
        engineState.activePositions.push(positionData);
        engineState.stats.predictions++;

        logEvent(`🛒 COMPRA SIMULADA INICIADA: [${side}] a ${(price * 100).toFixed(1)}¢ | Shares: ${sizeShares.toFixed(2)} | Stake: $${CONFIG.stakeAmount}`);

        if (!CONFIG.dryRun && clobClient && tokenId) {
            logEvent(`⚡ REAL TRADE INIT: Emitindo L2 LIMIT para [${side}] a ${(price * 100).toFixed(1)}¢...`);

            clobClient.createOrder({
                tokenID: tokenId,
                price: priceDecimal,
                side: "BUY",
                size: sizeShares,
                feeRateBps: 0
            }).then(resp => {
                logEvent(`✅ CONTRATO ASSINADO E ENVIADO: L2 Order ID ${resp.orderID || 'Concluído'}`);
            }).catch(e => {
                logEvent(`❌ ERRO L2: ${e.message.slice(0, 50)}`);
            });
        }
    } else if (_scanTick % 10 === 0) {
        // Log de rastreabilidade a cada 10 ticks (~10s)
        const tempo = data.timeLeftMin !== undefined ? `${Number(data.timeLeftMin).toFixed(1)}m` : "--";
        const fase  = data.phase || "ANALYSIS";
        const lado  = data.side || "?";

        if (data.reason === "missing_market_data") {
            logEvent(`🔎 [BTC | ${fase} | ${tempo}] ⚠️ SEM DADOS — Quotes do livro L2 indisponíveis.`);
        } else if (data.reason && data.reason.includes("edge_below")) {
            const edgeVal  = fmt(data.bestEdge, 4);
            const edgeMin  = fmt(data.threshold, 4);
            const edgeGap  = gap(data.bestEdge, data.threshold);
            const modelVal = pct(data.bestModel);
            logEvent(`🔎 [BTC | ${fase} | ${tempo}] Lado: ${lado} | Edge: ${edgeVal}${edgeGap} (mín ${edgeMin}) | Model: ${modelVal} — BLOQUEADO: edge insuficiente`);
        } else if (data.reason && data.reason.includes("prob_below")) {
            const edgeVal  = fmt(data.bestEdge, 4);
            const modelVal = pct(data.bestModel);
            const modelMin = pct(data.minProb);
            const modelGap = gap(data.bestModel, data.minProb);
            logEvent(`🔎 [BTC | ${fase} | ${tempo}] Lado: ${lado} | Edge: ${edgeVal} ✓ | Model: ${modelVal}${modelGap} (mín ${modelMin}) — BLOQUEADO: convicção baixa`);
        } else if (!data.signal || data.signal === "NO_TRADE") {
            const edgeVal  = fmt(data.bestEdge, 4);
            const modelVal = pct(data.bestModel);
            logEvent(`🔎 [BTC | ${fase} | ${tempo}] Lado: ${lado} | Edge: ${edgeVal} | Model: ${modelVal} — Aguardando confluência`);
        }

        // Log de scores técnicos a cada 30 ticks (~30s)
        if (_scanTick % 30 === 0 && data.upScore !== undefined) {
            const regime = data.regime || "-";
            logEvent(`📊 [BTC Scores | ${regime}] UP: ${data.upScore}pts | DOWN: ${data.downScore}pts | mkt UP: ${pct(data.marketUp)} | mkt DOWN: ${pct(data.marketDown)}`);
        }
    }

    if (engineState.openPosition) {
        const px = engineState.openPosition.side === "UP" ? data.marketUp : data.marketDown;
        if(px) {
            // Update active position Current Price (px já é decimal 0-1)
            const activeRef = engineState.activePositions.find(p => p.id === engineState.openPosition.id);
            if(activeRef) {
                activeRef.currentPrice = px;
                engineState.stats.positionsValue = activeRef.shares * activeRef.currentPrice;
            }

            // diff em decimal: 0.05 = 5 centavos de movimento
            const diff = px - engineState.openPosition.entryPrice;
            if (diff >= 0.05 || diff <= -0.05) {
                const multiplier = diff > 0 ? 0.3 : -0.3; // 30% ROI simulado
                const pnl = CONFIG.stakeAmount * multiplier;
                engineState.virtualBalance += pnl;

                if (diff > 0 && pnl > engineState.stats.biggestWin) engineState.stats.biggestWin = pnl;

                const entryPct  = (engineState.openPosition.entryPrice * 100).toFixed(1);
                const exitPct   = (px * 100).toFixed(1);
                const diffPct   = (diff * 100).toFixed(1);
                logEvent(`✅ POSIÇÃO FECHADA: ${diff > 0 ? 'Lucro' : 'Loss'} | Entrada: ${entryPct}¢ → Saída: ${exitPct}¢ (${diff > 0 ? "+" : ""}${diffPct}¢) | PnL: $${pnl.toFixed(2)} | Saldo: $${engineState.virtualBalance.toFixed(2)}`);

                // Move to closed
                const idx = engineState.activePositions.findIndex(p => p.id === engineState.openPosition.id);
                let closedPos = null;
                if(idx > -1) {
                    closedPos = engineState.activePositions.splice(idx, 1)[0];
                    closedPos.pnl      = pnl;
                    closedPos.exitPrice = px;
                    closedPos.closedAt  = Date.now();
                    engineState.closedPositions.push(closedPos);
                    engineState.stats.positionsValue = 0;
                }

                // Persistir
                if (_portfolio) {
                    const tradeRecord = {
                        coin: "BTC", side: closedPos?.side ?? "?",
                        entryPrice: closedPos?.entryPrice ?? 0, exitPrice: px,
                        pnl, newBalance: engineState.virtualBalance
                    };
                    recordClosedTrade(_portfolio, "BTC", tradeRecord);
                    appendTradeLog("BTC", tradeRecord);
                }

                engineState.openPosition = null;
            }
        }
    }
}
