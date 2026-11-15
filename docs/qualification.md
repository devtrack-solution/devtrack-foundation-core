> **Substituído em 2026-11-09 por [`qualification-2026-11-09.md`](qualification-2026-11-09.md).**
> Este rascunho foi escrito antes da correção de medição: os 30,52 s de recuperação do worker mediam
> até o fim da fase, não até o backlog zerar. A repetição com instrumento corrigido (`qmwa06n9g`)
> mediu 0,93 s. O critério de memória da D4 é RSS (memória residente), que atende (pior +3,83%);
> o heap do `api-b` (+19,32%) é observação, não meta da D4. Mantido só como histórico.

# Qualificação local — tarefa 7.2

Execução completa do perfil D4 (`decisions.md`), run `qmw9y8c2g`, de
2026-11-10T00:25:36.280Z a 2026-11-10T01:15:53.547Z (cerca de 50 min 17 s). Exit 0.
Evidência bruta: `contacts/test/load/results/qualification-2026-11-09.json`.

**Isto não autoriza alegação de capacidade em produção, nem em outro hardware, nem com
outro limite de admissão.** O texto de D4 já diz isso. Os números abaixo valem só para
esta máquina, esta composição e esta execução.

Dois critérios gravados no JSON **não atendem**:

- soak de memória, no veredito automático (heap de `api-b` +19,32% após o aquecimento);
- recuperação do worker (indexação completa 30,52 s após o reinício; meta ≤ 30 s).

O restante dos critérios automáticos atende, com os limites da seção 6. Não arredondar
os dois furos para "passou".

## 1. Cenário acordado

Fonte: D4 em `openspec/changes/define-native-foundation-operational-core/decisions.md`.

| Parâmetro | Meta D4 |
| --- | --- |
| Topologia | 2 réplicas de API + 1 worker em contêineres; PostgreSQL 16 e Redis 7 em contêiner; mesma máquina; recursos no relatório |
| Workload | 70% leitura (`GET /contacts/:id` e listagem), 30% escrita (`POST`/`PATCH`), payload de escrita ≤ 2 KB, 10 tenants, chaves únicas exceto 5% de repetições |
| Carga | 100 req/s por 10 min |
| Latência | leitura p95 ≤ 200 ms e p99 ≤ 500 ms; escrita p95 ≤ 400 ms e p99 ≤ 800 ms |
| Erros | erro não intencional < 0,5%; repetição idempotente sem efeito duplicado |
| Soak | 30 min a 50 req/s; RSS por processo < +15% após aquecimento |
| Saturação | rampa até rejeição; 429/503 observável; sem fila ou memória ilimitadas |
| Recuperação | reinício do PostgreSQL ou de um worker: volta a atender em ≤ 30 s, sem perda de outbox confirmado |
| Baseline | a primeira execução registrada é a baseline; as seguintes comparam contra ela |

## 2. O que rodou de fato

Comando: `npm run qual:load` em `contacts/` (sem `QUAL_SMOKE`). O gerador é open-loop
(`contacts/test/load/load.ts`): a latência conta a partir do instante agendado, então atraso
do cliente entra na medida. Timeout de requisição: 5 s. Uma falha de transporte é reenviada
uma vez para o outro alvo; timeout não é reenviado.

| Item | Pedido em D4 | Executado |
| --- | --- | --- |
| Réplicas e worker | contêineres | **processos Node no host** (`contacts/test/vertical/runners`), não contêineres |
| PostgreSQL / Redis | contêineres | `postgres:16-alpine` (servidor 16.15) e `redis:7-alpine` (7.4.12), criados pelo Testcontainers desta execução |
| Cliente | mesma máquina | sim; latência não inclui rede fora do host |
| Leitura | GET por id e listagem | sim, cerca de 70% (42.093 de 60.000 na carga) |
| Escrita | POST e PATCH | **só `POST /contacts`**. PATCH não entrou no mix |
| Payload | ≤ 2 KB | 78 bytes (`name` + um e-mail) |
| Tenants | 10 | 10, um subject cada |
| Repetições | 5% das escritas | probabilístico; na carga, 849 / 17.907 = 4,7% |
| Autenticação | não detalhada em D4 | **dublê** de token, sessão e identidade. JWT e store de sessão não foram medidos |

Recursos registrados pelo próprio run:

| Recurso | Valor |
| --- | --- |
| Host | Apple M1 Max, 10 CPUs lógicas, 64 GiB, macOS 27.2 (arm64) |
| Node | v24.21.0 |
| Docker | servidor 29.8.0; VM com 10 CPUs e 15,1 GiB |
| Pacotes | `foundation-api` 0.0.1, `@devtrack-solution/foundation-contacts` 0.1.0 |
| Contêineres | PostgreSQL `f502d2294536`, Redis `03dd916d7fa1` |

Composição do processo de API: persistência TypeORM (migrations no boot), fila BullMQ só
produtora, Contacts, relay de outbox, admissão e rate limit Redis. Worker separado consome
a fila. OpenTelemetry não entra nessa composição.

Admissão usada só nesta qualificação (não é default de produção):

| Parâmetro | Valor |
| --- | --- |
| `maxInFlight` / `maxQueue` / `maxQueueWaitMs` | 64 / 32 / 500 ms |
| Rate limit | token bucket, 1.200 tokens / 60 s, chave `sub:<tenant>:<subject>` |
| Falha do Redis | `fallback-local` |
| Timeout de comando Redis | 200 ms |

Com 10 subjects, o teto sustentado do limitador é 10 × (1.200 / 60) = **200 req/s**.
A rajada por subject é 1.200 tokens. Isso explica o platô medido; não é um teto do
aplicativo com o limitador desligado.

## 3. Resultados frente aos critérios

Números arredondados a 1 casa, como o veredito gravado no JSON. A fonte é o arquivo citado.

### 3.1 Carga — 100 req/s × 600 s

60.000 / 60.000 concluídas. Throughput de sucesso 100,00 req/s. Erro 0. Despacho do cliente
atrasou no máximo 48,7 ms (já incluído na latência).

| Critério | Meta | Medido | Veredito |
| --- | --- | --- | --- |
| Throughput | 100 req/s por 10 min | 100,00 req/s | atende |
| Leitura p95 / p99 | ≤ 200 / ≤ 500 ms | 5,8 / 11,4 ms | atende |
| Escrita p95 / p99 | ≤ 400 / ≤ 800 ms | 14,6 / 21,9 ms | atende |
| Erro não intencional | < 0,5% | 0,000% (0 / 60.000) | atende |
| Repetição sem efeito novo | 0 aceitas sem replay | 849 repetições, 0 sem replay, 0 rejeitadas | atende |

A escrita medida é só POST. Não usar esta linha para PATCH.

### 3.2 Soak — 50 req/s × 1.800 s

90.000 / 90.000, erro 0, 50,00 req/s de sucesso. Indexação ao fim: 25.634 / 25.634.

| Critério | Meta | Medido | Veredito |
| --- | --- | --- | --- |
| Erro | < 0,5% | 0,000% | atende |
| RSS após 300 s de aquecimento | < +15% por processo | api-a +0,05%, api-b −44,7%, worker-1 +3,83% | atende o texto de D4 |
| Heap, regra extra do harness | o JSON também exige < +15% | api-b **+19,32%**; api-a −1,01%; worker-1 −34,82% | **não atende** (veredito gravado) |

A janela é a primeira amostra com ≥ 300 s de soak (`tS` 1.519) contra a última (`tS` 3.016).
No mesmo intervalo o RSS de `api-b` caiu. Isso não prova vazamento residente e também não
autoriza apagar o veredito do JSON. Quem repetir a qualificação compara os dois, não só o
que convém.

### 3.3 Saturação — 400, 800 e 1.600 req/s, 60 s cada

| Degrau | Sucesso | 429 | 503 | Timeout |
| --- | --- | --- | --- | --- |
| 400 req/s | 399,3 req/s | 40 | 0 | 0 |
| 800 req/s | 201,7 req/s | 35.900 | 0 | 0 |
| 1.600 req/s | 201,3 req/s | 83.920 | 0 | 0 |

Latência de rejeição p99 = 4,4 ms. Latência máxima na rampa = 178,1 ms. Veredito automático:
atende (houve 429, sem timeout, p99 de rejeição ≤ 1 s).

O platô de ~201 req/s é o rate limit (seção 2), não a fila de admissão. **503 não apareceu.**
Não afirmar que o aplicativo satura em 200 req/s se o limitador for aumentado, nem que a fila
de admissão foi exercida.

### 3.4 Recuperação e falhas controladas

Carga de fundo: 50 req/s, exceto a fase "recuperação" (20 req/s, logo após a rampa). O teste
espera 10 s de propósito antes de religar réplica e worker (`RESTART_DELAY_MS`). Esse atraso
é do cenário, não do processo.

| Falha | O que aconteceu | Tempo medido | Veredito |
| --- | --- | --- | --- |
| Depois da rampa | primeiro segundo sem 429/503/erro | 0,00 s; fase seguinte com erro 0 | atende |
| SIGKILL de `api-a` | a outra réplica absorveu; 0 erro final na fase | 1,00 s até o primeiro segundo limpo; processo novo recebendo tráfego 1,43 s após o restart | atende |
| SIGKILL do worker | API seguiu com erro 0; outbox não se perdeu | indexação completa **30,52 s** após o restart (40,5 s após o kill, incluindo os 10 s injetados) | **não atende** |
| Redis indisponível (proxy TCP pausado ~20 s) | 282 eventos pendentes na retomada; 4 marcas de relay degradado; HTTP com erro 0; p95 de leitura subiu para 46,7 ms | outbox drenada em 20,00 s após o retorno | atende a janela de 30 s |
| Reinício do PostgreSQL | não executado | não medido | não reivindicado |

"Sem perda de outbox confirmado" vale para o run inteiro, não só para o worker: 60.970
criações nas respostas, 60.970 contatos no banco, 0 sem exatamente um evento de outbox, 0
sem exatamente uma indexação, 0 mensagem de inbox duplicada, 0 repetição aceita sem replay.
As 4 marcas de relay são da janela em que o Redis estava parado, não perda.

## 4. Baseline

Não há execução completa anterior. `qualification-2026-11-09-fumaca.json` é fumaça
(`QUAL_SMOKE=1`, 30 s por fase, schema de consistência antigo). **Não é baseline e não
comprova D4**, mesmo com todos os vereditos `atende`.

Esta execução é a baseline. Manifesto: `contacts/test/load/results/baseline.json`, apontando
para `qualification-2026-11-09.json`. Execução seguinte compara contra esse arquivo, no
mesmo perfil e na mesma máquina. Diferença de hardware, de limitador ou de mix invalida a
comparação.

Comparação interna, fase `baseline` (20 req/s × 120 s) contra a carga (100 req/s × 600 s).
Não é regressão entre runs.

| Métrica | Baseline 20 req/s | Carga 100 req/s | Delta |
| --- | --- | --- | --- |
| Leitura p95 | 11,0 ms | 5,8 ms | −47% |
| Leitura p99 | 14,6 ms | 11,4 ms | −22% |
| Escrita p95 | 20,7 ms | 14,6 ms | −30% |
| Escrita p99 | 28,6 ms | 21,9 ms | −24% |
| Erro | 0 | 0 | — |
| Throughput de sucesso | 20,00 req/s | 100,00 req/s | a taxa pedida |

A queda de latência entre as duas fases é aquecimento, não "a carga é mais rápida que a
baseline" como propriedade do sistema. Não extrapolar.

## 5. Consistência

`consistency.ok = true`.

| Checagem | Valor |
| --- | --- |
| Criações nas respostas | 60.970 |
| Contatos no banco | 60.970 |
| Sem exatamente uma indexação | 0 |
| Sem exatamente um evento de outbox | 0 |
| Inbox duplicada | 0 |
| Repetições intencionais | 4.902 |
| Aceitas sem replay | 0 |
| Rejeitadas por 429/503 (sem efeito) | 1.951 (todas na rampa) |

## 6. Limites — o que esta execução não prova

1. Produção, outro host, outra região, outro tamanho de pool, outro limitador.
2. Réplicas e worker em contêiner. Rodaram como processo no host. Cgroup, rede de overlay e
   limite de memória do contêiner de aplicação não foram medidos.
3. `PATCH /contacts/:id`. A latência de escrita é de POST idempotente com outbox.
4. JWT, rotação de refresh, store de sessão. O verificador desta composição é dublê.
5. Reinício do PostgreSQL. Queda de banco, failover e tempo até `/health/ready` não foram
   medidos aqui.
6. Saturação do aplicativo acima do rate limit. 503 de admissão não ocorreu. Memória na
   rampa subiu (RSS das APIs foi de ~230 MiB para ~400 MiB em cerca de 2 min) e depois
   recuou; isso não é prova de limite sob sobrecarga longa com o limitador aberto.
7. OpenTelemetry sob esta carga. O collector desligado foi medido na tarefa 5.2, não aqui.
8. O furo de 0,52 s na indexação pós-restart e o heap de `api-b` no soak. São fatos desta
   execução, não ruído a descartar.
9. A fumaça de 30 s.

Repetir: `cd contacts && npm run qual:load`. Exige Docker. Cria os próprios contêineres de
PostgreSQL e Redis e não deve ser lida como aceite de produção mesmo se todos os vereditos
vierem `atende`.
