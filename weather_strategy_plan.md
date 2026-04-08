# Estratégia de Arbitragem Metereológica (Weather Theta Gang)

## 1. O Conceito Base
Inspirado pelos altos ganhos consistentes ("Penny Picking") vistos em contas quantitativas da Polymarket, este módulo foca em fechar apostas no **"NO"** com elevadíssima taxa de acerto. A estratégia aposta contra eventos meteorológicos altamente improváveis baseada no decaimento do tempo.

Exemplo: Faltam 4 horas para o dia acabar em Xangai. O limite estipulado pelo mercado é de 30ºC. Todas as fontes meteorológicas apontam a temperatura atual em 24ºC e a máxima prevista para o resto do dia não ultrapassará 25ºC. A chance de subir 6ºC à noite é estatisticamente nula. Compramos o `NO` na casa dos 95~98¢ para colher lucros com "Risco Zero".

## 2. A Arquitetura de "Consenso Segregado" (Multi-Oracle)
Para evitar falhas ou "Spoofing" de APIs únicas, o motor não vai depender de uma base de dados pontual. Se apenas uma fonte for falha, o robô não fará a entrada. O robô só executa **SE, E SOMENTE SE**, múltiplas fontes confiáveis entrarem em Acordo Absoluto (Match Positivo).

### Potenciais Fontes Meteorológicas para o Consenso:
1. **Open-Meteo API**: Altamente robusta, agrega fontes governamentais e não requer chaves para uso amador.
2. **OpenWeatherMap**: O padrão da indústria (é o mais comumente usado como "oráculo" de liquidação pelas regras oficiais da Polymarket).
3. **WeatherAPI / AccuWeather**: Dados focados no hiper-local, ajudam a evitar outliers e desvios de radar.

## 3. Lógica do Loop de Interceptação (`weatherEngine.js`)

1. **Varredura (Cronjob)**: De 5 em 5 minutos, o bot requisitará na *Gamma API da Polymarket* todos os mercados nas Tags `Weather`.
2. **Filtro de Viabilidade**: Isola mercados que estão "ativos" (não suspensos) e vencem nas próximas 1h a 6 horas (Tempo crítico).
3. **Cruzamento de Limiar (Threshold)**: Puxa os dados dos oráculos cruzando o *Target Price/Temp* da aposta.
4. **Votação**:
   - Fonte 1: Confirma Improbabilidade Absoluta? (Sim/Não)
   - Fonte 2: Confirma Improbabilidade Absoluta? (Sim/Não)
   - Fonte 3: Confirma Improbabilidade Absoluta? (Sim/Não)
5. **Gatilho**: Se 3 de 3 disserem "Sim", e o preço da "Ponta do Book" (Spread) for aceitável de se comprar (ex: até 98 centavos), a máquina emite o sinal mágico `[ENTER NOW (BUY NO)]` enviando a Ordem Limitada pro `executor.js`.

## 4. Integração Visual Front-End
O seu Painel Web passará a rodar duas telas (ou abas) simultâneas:
* `Módulo A`: Crypto 15min Momentum
* `Módulo B`: Weather Arbitrage Node

A carteira de PnL no Dashboard será fundida, operando de fato como um Fundo Quantitativo Unificado (Hedge Fund).
