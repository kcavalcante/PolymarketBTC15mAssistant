/**
 * Registro de moedas suportadas pelo bot.
 * Cada entrada define os parâmetros de análise e mercado Polymarket.
 */
export const COINS = [
    {
        key:          "BTC",
        symbol:       "BTCUSDT",
        label:        "Bitcoin",
        decimals:     0,
        useChainlink: true,   // única moeda com oráculo Chainlink configurado
        polymarket: {
            seriesId:         "10192",
            seriesSlug:       "btc-up-or-down-15m",
            slugCandidates:   ["btc-up-or-down-15m"],
            upOutcomeLabel:   "Up",
            downOutcomeLabel: "Down"
        }
    },
    {
        key:          "ETH",
        symbol:       "ETHUSDT",
        label:        "Ethereum",
        decimals:     2,
        useChainlink: false,
        polymarket: {
            seriesId:         "10191",
            seriesSlug:       "eth-up-or-down-15m",
            slugCandidates:   [],
            upOutcomeLabel:   "Up",
            downOutcomeLabel: "Down"
        }
    },
    {
        key:          "SOL",
        symbol:       "SOLUSDT",
        label:        "Solana",
        decimals:     3,
        useChainlink: false,
        polymarket: {
            seriesId:         "10423",
            seriesSlug:       "sol-up-or-down-15m",
            slugCandidates:   [],
            upOutcomeLabel:   "Up",
            downOutcomeLabel: "Down"
        }
    },
    {
        key:          "XRP",
        symbol:       "XRPUSDT",
        label:        "XRP",
        decimals:     4,
        useChainlink: false,
        polymarket: {
            seriesId:         "10422",
            seriesSlug:       "xrp-up-or-down-15m",
            slugCandidates:   [],
            upOutcomeLabel:   "Up",
            downOutcomeLabel: "Down"
        }
    }
];

export const COIN_MAP = Object.fromEntries(COINS.map(c => [c.key, c]));
