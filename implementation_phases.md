# Plano de Implementação de Fases: Polymarket BTC 15m Assistant & Automação

Este documento detalha o passo a passo para transformar o Assistente de Terminal em uma **Plataforma Autônoma Local** de operação automatizada completa com **Dashboard na Web** utilizando 100% stack em Node.js.

---

## 🎯 Fase 1: Infraestrutura e Servidor Backend
Nesta fase, nós vamos modificar o "coração" do bot que joga dados apenas no console preto para que ele vire um transmissor de alta velocidade para a Web e prepararemos as chaves.

1. **Expansão do Config / Variáveis de Ambiente:**
   - Preencheremos no `config.js` a estrutura para ler e suportar as credenciais de Trading (`CLOB_API_KEY`, `SECRET`, `PASSPHRASE` com chaves locais mockadas para você substituir).
   - Inserir a flag mãe global: `DRY_RUN=true` (Modo Simulado por padrão para segurança).
2. **Servidor Express e WebSockets:**
   - Instalar o framework de roteamento super-leve `express` (`npm i express`).
   - Ajustar o fluxo final do `index.js` para ligar um servidor HTTP na porta `:3000`.
   - Ligar um servidor de Websockets na mesma porta que envia um payload de dados em cada *tick* da máquina (RSI, Prices, Sinais).
3. **Ponte de Arquivos Frontend:**
   - Criar e rotear o diretório raiz `/public` onde ficarão os arquivos da nossa interface moderna de visualização em tempo real.

---

## 🖥 Fase 2: Front-end (Web Dashboard Interativa)
Nesta fase vamos criar a interface de acompanhamento sem ferramentas arcaicas, aproveitando o tempo real moderno.

1. **Construção do Layout Base:**
   - Criação do arquivo `/public/index.html` consumindo Tailwind CSS (via CDN ou Vanilla CSS Premium) para um visual limpo estilo interface de Home Broker, em especial usando Dark Mode.
2. **Gráficos em Tempo Real (Chart.js):**
   - Inserir via CDN a biblioteca `Chart.js` ou semelhante para criar diagramas de linhas em tempo real baseados nas mensagens emitidas pelo WebSockets (Rastreio visual contínuo das bordas "Model Up" e "Model Down").
3. **Tabela de Live Console & Atividades:**
   - Quadro reativo "Últimos Eventos" mostrando visualmente o estado atual da probabilidade.
   - Mostrar o PnL simulado (lucros/perdas em Modo Teste).
4. **Painel de Controle e Parametrização Dinâmica:**
   - **Timeframe:** Seletor de Minutagem (para alternar a base dos candles de 15m para durações maiores/menores dinamicamente via backend).
   - **Controle de Banca:** inputs configuráveis na tela para *Stop Win*, *Stop Loss* diário e configuração do *Stake* (tamanho de capital alocado por trade). Quando alterados na web, estes valores sincronizam com o core do Node.js.

---

## ⚙️ Fase 3: Engine Estratégica (Paper Trader & Lógica de Entradas)
A parte onde conectamos a decisão estática a uma memória local simulando finanças.

1. **Módulo de Execução Virtual (`src/engines/executor.js`):**
   - Criação de um motor focado exclusivamente no "Gatilho de Compras". Assim que o Bot atual sinalizar `ENTER NOW (BUY UP)` ou `DOWN`, ele intercepta essa ordem.
2. **Sistema de Paper Trading:**
   - Quando `DRY_RUN=true`, este módulo anota em um novo banco local em memória ou .json o histórico de operações virtuais ("Comprado em $50% (Up)...").
   - Quando a opção for avaliada no vencimento, ele calculará de forma virtual o lucro simulado ($ gain/loss).
3. **Mecanismo Anti-Spam de Ordens:**
   - Precisaremos colocar uma regra de não fazer double-spending; ou seja, comprar uma vez na mesma janela ou não comprar mais que um limite de capital definido para não entrar numa repetição recursiva.
4. **Gerenciamento de Risco e Controle de Banca (Engine):**
   - O `executor.js` monitorará os valores de liquidez ou PnL virtual contra as metas (*Stop Win/Loss* estabelecidos via Web).
   - Caso os limites base (*Stakes* e perdas) sejam atingidos, o algoritmo "trava" o módulo de execução (seja Real ou Simulado), protegendo seu saldo ou segurando seu lucro com segurança.

---

## 🚀 Fase 4: Real Trader (Integração Polymarket Clob-Client Oficial)
Nesta última parte, nós vamos transformar as ordens de brincadeira no protocolo oficial L2.

1. **Instalação do Clob-Client do Polymarket:**
   - Inclusão e configuração do repositório oficial cliente de NodeJS do Polymarket (`@polymarket/clob-client`).
2. **Construção da Camada de Assinatura:**
   - Refinamento do `executor.js` para usar o Ethers + wallet key e as `API Keys`.
   - Quando `DRY_RUN=false` e sob condições de gatilhos rígidas, a API enviará os pacotes JSON de requisição final autorizada, gastando os fundos em rede para fechar a posição.
3. **Gestão de Sincronia Rápida em Real Time (Slippage Tolerances):**
   - Como os mercados de 15 minutos dependem de alta precisão em instantes pequenos de preço, calibraremos ordens `LIMIT` flexíveis do Clob usando derrapagem inteligente para assegurar que suas decisões de bot consigam de fato liquidez do mercado.

---
**Status Atual:** Plano Pronto. Aguardando aprovação para iniciarmos a programação e execução da **Fase 1**!
