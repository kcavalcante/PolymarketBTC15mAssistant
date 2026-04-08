# Análise e Planejamento: Polymarket BTC 15m Assistant

Este documento fornece um detalhamento sobre o funcionamento do repositório `PolymarketBTC15mAssistant`, uma verificação de segurança, além de roteiros para automatizar operações com a arquitetura do **OpenClaw** e criar uma interface interativa usando **Streamlit**.

---

## 1. O que o sistema faz (Visão de Negócio)
O sistema atual é um **Assistente de Trading em tempo integral (Dashboard de Terminal)** voltado especificamente para os mercados de previsão de curtíssimo prazo da Polymarket ("Bitcoin Up or Down 15-minute").

### Principais Funcionalidades:
- **Agregação de Preços:** Combina dados do Clob (Livro de ofertas) da Polymarket para as opções "UP" (Sobe) e "DOWN" (Desce), e contrapõe com a fonte da verdade usada pela Polymarket (nó da Chainlink na rede Polygon) e com a cotação spot da Binance.
- **Análise de Dados e Indicadores:** Identifica a "Probabilidade (Edge)" utilizando análise técnica sobre a janela de tempo de 15 minutos. Ele checa:
  - **VWAP (Preço Médio Ponderado por Volume):** Identifica a força e tendência recente.
  - **Heikin Ashi e RSI:** Usados para verificação da força de reversão e tendência.
  - **MACD e Delta:** Validam o *momentum* que suporta ou não o palpite de direção do mercado em relação ao "Preço de Referência" (Price to Beat).
- **Geração de Sinal (Recomendação):** Baseado na combinação dos fatores acima + a relação de tempo restante para a expiração do mercado x probabilidade do algoritmo x cotações no Clob, o script imprime recomendações (ex: `ENTER NOW (BUY UP)` ou `NO TRADE`).
- **Registro em CSV:** Todas as decisões e condições analisadas são salvas no arquivo `./logs/signals.csv`, criando um histórico vital para revisão de estratégia.

---

## 2. Visão Técnica e Arquitetura Atuais
O projeto não executa operações (compras/vendas). Ele apensas **lê dados** e gera **sinais visuais**.

**Stack Tecnológico Atual:**
- **Node.js**: Backend do código assíncrono.
- **Bibliotecas-chave**: 
  - `ws`: Comunicação via WebSocket diretamente dos feeds das exchanges (Polymarket CLOB / Binance Trade Stream / Node Polygon / RPC Ankr).
  - `ethers`: Usado apenas para processar dados de blockchain no arquivo de configuração e lidar com algumas abstrações de Hex/endereços do ChainLink.
  - `undici`: Utilizada de forma velada para requisições com alta performance.

**Fluxo de Dados:**
1. A cada pulso (`pollIntervalMs = 1_000`), a função `fetchPolymarketSnapshot` busca a fotografia do Clob da Polymarket.
2. Analisadores Técnicos processam e avaliam a métrica `computeEdge` em `./src/engines/edge.js`.
3. É impresso no console um painel gerado sem bibliotecas pesadas de interface visual (`readline.cursorTo`).

---

## 3. Dupla Checagem de Segurança (Security Double-Check)
O código existente é **100% SEGURO** para uso em seu estado original.
- **Isenção de Chaves Privadas (Private Keys):** O código em toda a pasta `src/` não solicita, não usa e não tem dependências implementadas para ler ou gerir senhas/carteiras na Polygon (Ethereum). Ele atua com "Read-only" (apenas leitura).
- **Vazamento de Dados:** As variáveis de ambiente (ex: Roteamento de Proxy, URLs do Polygon RPC) só transitam publicamente quando comunicam os respectivos servidores da web.
- **Dependências Confiáveis:** O `package.json` possui dependências padrões e muito famosas na comunidade (`ethers`, `ws`, agentes de proxy). 
- **Conclusão:** Você fez uma boa escolha avalizando esse repositório. O bot é totalmente observacional.

---

## 4. Roteiro para Automação com OpenClaw (Simulado vs. Real)
O **OpenClaw** é um framework moderno que funciona integrado na dinâmica de IA ou "Trading Autônomo Modular" interconectando APIs com agentes capazes de gerar "execuções de trade" programadas.

### Chaves (Keys) Necessárias para Operar
Para transformar a inteligência deste projeto num executor através do CLOB Polymarket (via OpenClaw ou qualquer API Client oficial Python/Node), você precisará configurar as seguintes chaves em um ambiente seguro (*.env*):
1. `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE` (Geradas internamente ao desbloquear o Trading nas "Settings" da conta da Polymarket).
2. `WALLET_PRIVATE_KEY` ou Conta L1 com fundos (USDC.e) na rede Polygon, que será o dono oficial do seu perfil (o *Proxy Wallet* CTF Polymarket).
3. Uma `CHAIN_ID` configurada (geralmente `137` para Polygon Mainnet).

### Como estruturar o Paper Trading (Modo Simulado)
A Polymarket possui liquidez quase nula no Testnet da Ethereum/Amoy. Para fazer **Paper Trading preciso**:
1. **DRY RUN Mode (Shadow Trading):** Configure na lógica do seu robô autônomo uma chave booleana (`DRY_RUN=True`).
2. Quando o bot disparar o "BUY UP", ao invés de assinar a Order, grave no banco de dados: *"Preço Capturado no Ask / Frações USDC / Resultado Esperado"*.
3. Depois de 15 minutos (na verificação de encerramento do mercado), a matemática confere se o valor virtual obteve "Loss" ou "Gain" subtraindo as taxas da infraestrutura da Polymarket da conta de demonstração.

### Como estruturar o Real Trading
Ao migrar do simulado para real (`DRY_RUN=False`):
- O OpenClaw formata e assina a transação L2 para o CLOB. 
- **Importante:** Em mercados de 15 minutos, a latência pune pesado. Recomendamos sempre utilizar Ordens Limite postadas com um pouco de derrapagem (*Slippage* intencional) e em nodes privados RPC do Polygon que respondam rápido.

---

## 5. Planejamento do Dashboard (Web Dashboard Nativo em Node.js)

Como todo o ecossistema do seu assistente está rodando em **Node.js**, misturar Python (Streamlit) exigiria manter duas stacks separadas. Para manter a elegância e a simplicidade arquitetural de um stack único, a melhor solução é expandir o bot atual utilizando servidor HTTP nativo e WebSockets.

### Estrutura de Integração ("Node Logic" -> "Web Vision")
Nossa estratégia manterá o sistema rápido e livre de complexidades. A ideia é:
1. Adicionar o **Express** (ou módulo nativo `http`) para servir uma simples página HTML/JS a partir de uma pasta `./public`.
2. Usar **Socket.io** (ou `ws`, que já está instalado) para disparar ("emitir") as métricas, exatamente no mesmo instante em que a função `renderScreen()` exibe os dados coloridos no terminal.
3. O Frontend (uma página web em *Vanilla JS* ou usando *Vite + React*) escuta via WebSocket e atualiza gráficos estilizados na tela.

### Principais Componentes que Faremos no Dashboard
* **Módulo 1: Servidor Local (Frontend Viewer)**
  - O `index.js` vai subir uma porta local (ex: `http://localhost:3000`).
  - Ao entrar, o HTML recebe o sinal em tempo real (RSI, Modelo Up/Down, Delta) com zero latência (pois estão no mesmo processo de memória).
* **Módulo 2: Gráficos de Sinais no Front**
  - Utilizaremos a biblioteca **Chart.js** ou **Lightweight Charts (TradingView)**. Toda vez que o Socket emitir um pacote, injetaremos um novo ponto nos gráficos de "Market Up/Down" e de "Probabilidade (Model)".
* **Módulo 3: Interface de Simulador de Trades (Paper Trading)**
  - Um painel na web contendo botão "Ativar Robô" (Simulação).
  - Um bloco registrando as vitórias/derrotas que foram calculadas com os parâmetros de *Dry-Run* mencionados acima, sem precisar fechar o terminal num CSV.

### Exemplo de Rascunho da Melhoria no `index.js`
```javascript
import express from 'express';
import { WebSocketServer } from 'ws';

// 1. Cria servidor express para servir o dashboard visual
const app = express();
app.use(express.static('public')); // O html do painel fica aqui
const server = app.listen(3000, () => console.log('Painel web em http://localhost:3000'));

// 2. Acopla o WebSockets no mesmo servidor web
const wss = new WebSocketServer({ server });

// ... (No momento do seu loop em que gera as variáveis) 
function broadcastData(data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(JSON.stringify(data));
  });
}

// 3. Ao calcular as linhas da console:
broadcastData({
  rsi: rsiNow,
  model_up: timeAware.adjustedUp,
  model_down: timeAware.adjustedDown,
  recommendation: rec.action
});
```

*(Este plano nativo de Node.js garante que não haverá conflitos de "stack" (linguagens) e aproveita o tempo real do WebSocket diretamente do motor original do bot.)*
---
*Este documento é o plano principal do projeto. Pode ser utilizado para gerenciar as prioridades dos módulos seguintes!*
