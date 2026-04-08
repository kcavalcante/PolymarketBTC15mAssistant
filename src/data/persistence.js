/**
 * Camada de persistência — JSON local, interface DB-ready.
 *
 * Para migrar para SQLite/Postgres no VPS, basta reimplementar as funções
 * exportadas mantendo a mesma assinatura. O resto do código não muda.
 */

import fs   from "node:fs";
import path from "node:path";

const DATA_DIR       = "./data";
const PORTFOLIO_FILE = path.join(DATA_DIR, "portfolio.json");
const HISTORY_FILE   = path.join(DATA_DIR, "trade_history.json");

function ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── Schema padrão ───────────────────────────────────────────────────────────

function emptyPortfolio() {
    return {
        version: 1,
        lastSaved: null,
        engines: {}
    };
}

function emptyEngine() {
    return {
        virtualBalance: 0,
        stats: { predictions: 0, wins: 0, losses: 0, biggestWin: 0 },
        balanceHistory: [],          // [{ ts: number, balance: number }]
        closedPositions: []          // últimos 200 trades
    };
}

// ─── Portfolio (estado consolidado) ──────────────────────────────────────────

export function loadPortfolio() {
    ensureDir();
    try {
        if (fs.existsSync(PORTFOLIO_FILE)) {
            const raw  = fs.readFileSync(PORTFOLIO_FILE, "utf8");
            const data = JSON.parse(raw);
            // Garantir schema mínimo em cada engine
            for (const key of Object.keys(data.engines ?? {})) {
                const e = data.engines[key];
                e.balanceHistory  = e.balanceHistory  ?? [];
                e.closedPositions = e.closedPositions ?? [];
                e.stats           = { ...emptyEngine().stats, ...(e.stats ?? {}) };
            }
            return data;
        }
    } catch (err) {
        console.error("[persistence] Erro ao carregar portfolio:", err.message);
    }
    return emptyPortfolio();
}

export function savePortfolio(data) {
    ensureDir();
    try {
        data.lastSaved = new Date().toISOString();
        fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
        console.error("[persistence] Erro ao salvar portfolio:", err.message);
    }
}

// ─── Operações por engine ─────────────────────────────────────────────────────

/**
 * Carrega o estado salvo de um engine específico.
 * Retorna emptyEngine() se não existir.
 */
export function loadEngineState(portfolio, engineKey) {
    return portfolio.engines[engineKey] ?? emptyEngine();
}

/**
 * Registra um trade fechado e atualiza balance/stats.
 * Chama savePortfolio internamente.
 */
export function recordClosedTrade(portfolio, engineKey, trade) {
    if (!portfolio.engines[engineKey]) {
        portfolio.engines[engineKey] = emptyEngine();
    }
    const eng = portfolio.engines[engineKey];

    // Atualizar saldo
    eng.virtualBalance = trade.newBalance;

    // Stats
    eng.stats.predictions++;
    if (trade.pnl > 0) {
        eng.stats.wins++;
        if (trade.pnl > eng.stats.biggestWin) eng.stats.biggestWin = trade.pnl;
    } else {
        eng.stats.losses++;
    }

    // Histórico de saldo (para linha de evolução)
    eng.balanceHistory.push({ ts: Date.now(), balance: trade.newBalance });
    if (eng.balanceHistory.length > 500) eng.balanceHistory.shift();

    // Histórico de trades (últimos 200)
    eng.closedPositions.push({
        ...trade,
        savedAt: new Date().toISOString()
    });
    if (eng.closedPositions.length > 200) eng.closedPositions.shift();

    savePortfolio(portfolio);
}

/**
 * Sincroniza o virtualBalance de um engine (sem registrar trade).
 * Usado no startup para restaurar saldo salvo.
 */
export function syncEngineBalance(portfolio, engineKey, balance) {
    if (!portfolio.engines[engineKey]) {
        portfolio.engines[engineKey] = emptyEngine();
    }
    portfolio.engines[engineKey].virtualBalance = balance;
    savePortfolio(portfolio);
}

// ─── Gestão de Banca: histórico diário de saldo ──────────────────────────────

/**
 * Registra o saldo total do portfólio para o dia de hoje.
 * - Primeira chamada do dia: cria entrada com startBalance = endBalance = total
 * - Chamadas subsequentes: atualiza apenas endBalance
 */
export function recordDailyBalance(portfolio, totalBalance) {
    if (!portfolio.dailyHistory) portfolio.dailyHistory = [];

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const last  = portfolio.dailyHistory[portfolio.dailyHistory.length - 1];

    if (last && last.date === today) {
        last.endBalance = totalBalance;
        last.pnl        = totalBalance - last.startBalance;
    } else {
        portfolio.dailyHistory.push({
            date:         today,
            startBalance: totalBalance,
            endBalance:   totalBalance,
            pnl:          0
        });
        if (portfolio.dailyHistory.length > 365) portfolio.dailyHistory.shift();
    }
    savePortfolio(portfolio);
}

// ─── Histórico de trades (log separado, append-only) ─────────────────────────

export function appendTradeLog(engineKey, trade) {
    ensureDir();
    try {
        let history = [];
        if (fs.existsSync(HISTORY_FILE)) {
            history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
        }
        history.push({ engine: engineKey, ...trade, ts: new Date().toISOString() });
        // Manter últimos 2000 trades no arquivo
        if (history.length > 2000) history = history.slice(-2000);
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf8");
    } catch { /* silencioso */ }
}
