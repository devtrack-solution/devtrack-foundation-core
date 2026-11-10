# Qualificação local de carga, soak e falhas (perfil D4), 2026-11-09

Tarefa 7.2 da mudança `define-native-foundation-operational-core`. Perfil **local**, conforme a decisão D4 de `openspec/changes/define-native-foundation-operational-core/decisions.md`. Estes números não autorizam nenhuma alegação de capacidade em produção.

Dados brutos (JSON, mesma pasta do harness):

- `contacts/test/load/results/qualification-2026-11-09.json`: execução completa (run `qmw9y8c2g`).
- `contacts/test/load/results/qualification-2026-11-09-falhas.json`: repetição das três falhas controladas, com instrumentação de recuperação corrigida (run `qmwa06n9g`).
- `contacts/test/load/results/qualification-2026-11-09-fumaca.json`: última fumaça (só falhas, 30 s por fase).

## 1. Ambiente exato

| Item | Valor |
| --- | --- |
| Máquina | Apple M1 Max, 10 CPUs lógicas (`hw.ncpu`), 64 GiB RAM (`hw.memsize` = 68719476736) |
| Sistema | macOS 27.2 (build 26B123), arm64 |
| Node.js | v24.21.0 (processos da API, worker e gerador de carga; `ts-node` em modo `transpile-only`) |
| Docker | Docker Desktop, Engine 29.8.0; VM do Docker com 10 CPUs e 15,1 GiB |
| PostgreSQL | 16.15 (`postgres:16-alpine`), contêiner criado pelo teste |
| Redis | 7.4.12 (`redis:7-alpine`), contêiner criado pelo teste; acesso pelo proxy TCP do teste |
| Topologia | 2 réplicas da API + 1 worker (processos separados, runners do harness vertical) |
| Cliente | gerador open-loop no mesmo host, sem dependências novas (`node:http`) |

Configuração de admissão e rate limit, ligada só no runner de qualificação (ver `foundation-api/docs/admission.md`):

- `maxInFlight` 64, `maxQueue` 32, `maxQueueWaitMs` 500, `drainDeadlineMs` 10000, `retryAfterSeconds` 1.
- Rate limit compartilhado por subject: 1.200 fichas com reposição de 1.200 por 60 s, ou seja, 20 req/s por tenant. Com 10 tenants, o teto sustentado é de 200 req/s agregados, com rajada de 1.200 por tenant. Política escolhida para o teste, não é meta de D4.
- `failurePolicy` `fallback-local`, `sharedTimeoutMs` 200 ms, `commandTimeoutMs` 200 ms.

Nada de código de produção foi alterado. O harness recebeu campos opcionais e marcas de memória (ver seção 8).

## 2. Protocolo executado

Carga de contatos com 10 tenants (`tenant-load-1` a `tenant-load-10`), mistura 70% leitura (metade `GET /contacts/:id`, metade `GET /contacts?limit=20`) e 30% escrita (`POST /contacts` com `Idempotency-Key` única, payload de cerca de 150 bytes). Cerca de 5% das escritas repetem uma chave já concluída. A latência de cada requisição é medida a partir do instante agendado (sem omissão coordenada). O atraso de despacho do próprio cliente é registrado em `dispatchLagMaxMs`.

Fases da execução completa, em ordem: semeadura (5 s, 100 req/s, só escritas), aquecimento (20 req/s, 60 s), baseline (20 req/s, 120 s), carga (100 req/s, 600 s), saturação em degraus de 400, 800 e 1.600 req/s (60 s cada), recuperação (20 req/s, 60 s), falha de réplica, falha de worker e falha de Redis (cada uma com 50 req/s durante 60 s) e soak (50 req/s, 1.800 s), com amostragem de memória a cada 15 s.

Falhas controladas: SIGKILL de `api-a` no segundo 20 da fase, reinício 10 s depois; SIGKILL de `worker-1` no segundo 20, reinício 10 s depois; indisponibilidade do Redis pelo proxy TCP entre os segundos 20 e 40. A execução completa durou cerca de 50 min (de 00:25:36 a 01:15:53 UTC).

## 3. Resultados por fase (execução completa)

Latências em milissegundos. Vazão de sucesso em req/s. "Erros" são respostas não 2xx ou falhas de transporte finais.

| Fase | Taxa | Agendadas / concluídas | Vazão de sucesso | Leitura p50 / p95 / p99 | Escrita p50 / p95 / p99 | Erros (código) |
| --- | --- | --- | --- | --- | --- | --- |
| semeadura | 100 | 500 / 500 | 100,00 | - | 6,5 / 8,5 / 11,8 | 0 |
| aquecimento | 20 | 1.200 / 1.200 | 20,00 | 6,3 / 11,7 / 16,8 | 13,0 / 22,7 / 29,3 | 0 |
| baseline | 20 | 2.400 / 2.400 | 20,00 | 5,4 / 11,0 / 14,6 | 11,4 / 20,7 / 28,6 | 0 |
| carga | 100 | 60.000 / 60.000 | 100,00 | 2,9 / 5,8 / 11,4 | 7,1 / 14,6 / 21,9 | 0 |
| saturação 400 | 400 | 24.000 / 24.000 | 399,33 | 2,1 / 3,2 / 7,5 | 5,3 / 9,6 / 23,3 | 40 (`http_429`), 0,17% |
| saturação 800 | 800 | 48.000 / 48.000 | 201,67 | 1,7 / 3,1 / 7,1 | 1,9 / 7,2 / 14,9 | 35.900 (`http_429`), 74,79% |
| saturação 1600 | 1.600 | 96.000 / 96.000 | 201,33 | 1,6 / 2,8 / 4,5 | 1,6 / 6,4 / 8,7 | 83.920 (`http_429`), 87,42% |
| recuperação | 20 | 1.200 / 1.200 | 20,00 | 6,1 / 13,9 / 21,4 | 11,0 / 23,2 / 33,1 | 0 |
| falha de réplica | 50 | 3.000 / 3.000 | 50,00 | 4,2 / 10,5 / 16,2 | 9,6 / 19,7 / 30,3 | 0 final; 11 retentativas de transporte |
| falha de worker | 50 | 3.000 / 3.000 | 50,00 | 5,0 / 10,0 / 13,3 | 11,1 / 19,3 / 25,3 | 0 |
| falha de Redis | 50 | 3.000 / 3.000 | 50,00 | 4,8 / 46,7 / 67,2 | 11,1 / 52,4 / 74,9 | 0 |
| soak | 50 | 90.000 / 90.000 | 50,00 | 4,6 / 13,7 / 27,3 | 10,3 / 26,3 / 59,1 | 0 |

Totais: 60.970 contatos criados por resposta, todos presentes no banco. Repetições intencionais: 4.902 (4,9% das escritas), das quais 0 foram aceitas sem replay e 1.951 foram rejeitadas pela admissão durante a saturação (sem efeito). Mistura de leitura: 70,0%.

Observações de cliente: o atraso máximo de despacho foi de 48,7 ms na carga, 26,1 ms na saturação e 115 ms no soak (128 ms na falha de Redis da repetição). Esse atraso entra na latência medida, porque a latência começa no instante agendado. Em alguns momentos o próprio cliente ficou mais de 100 ms atrás do cronograma, o que deve ser considerado ao ler os percentis desses trechos.

Saturação: no degrau de 400 req/s não houve nenhuma rejeição por 60 s, exceto 40 respostas 429 (provavelmente no fim do degrau, quando as fichas da rajada se esgotaram). Acima disso, o que limita é a política de rate limit: a vazão de sucesso estabiliza em cerca de 200 req/s agregados, e a rejeição 429 responde em p99 de 4,4 ms. Na fumaça com 1.600 req/s apareceram também 13 respostas 503 (fila de admissão cheia), mas na execução completa não houve nenhuma 503. Por isso o caminho de 503 foi observado só na fumaça.

## 4. Falhas controladas e tempos de recuperação

Recuperação é medida pelo primeiro segundo sem erro final após o evento (`firstCleanSecond`), e, quando aplicável, por instantes observados diretamente (tráfego de volta, backlog zerado).

| Falha (carga de 50 req/s) | Execução completa | Repetição com instrumentação corrigida | Observação |
| --- | --- | --- | --- |
| SIGKILL de `api-a` (réplica) | 0 erro final, 11 retentativas, recuperação 1,00 s, tráfego de volta 1,43 s após o reinício | 0 erro final, 11 retentativas, recuperação 0,00 s, tráfego de volta 1,45 s | O cliente reenvia a requisição em `api-b` com a mesma `Idempotency-Key`. |
| SIGKILL de `worker-1` | Valor de recuperação **inválido** (ver seção 7). Efeito: 0 violações de indexação única | Backlog de pico de 145 contatos no reinício; zerado 0,93 s depois | Efeito único: 0 contatos com indexação diferente de exatamente uma; 0 mensagens de inbox duplicadas. |
| Redis indisponível (proxy, 20 s) | 0 erro final; pico de 282 eventos pendentes ao retornar; outbox zerada 20,0 s após o retorno | 0 erro final; pico de 543 pendentes; outbox com 5 ou menos pendentes em 19,7 s após o retorno | Ver seção 6 sobre a causa do intervalo de ~20 s. |
| Sobrecarga (saturação) | Primeiro segundo sem 429/503/erro: 0,00 s após o fim do degrau | - | Após 1.600 req/s, a carga voltou a 20 req/s sem rejeição. |

Requisições durante a falha de Redis tiveram latência maior (escrita p95 52 ms contra cerca de 20 ms nas outras fases), sem erros. A causa não foi isolada. Hipótese: as tentativas de consulta ao armazenamento compartilhado do rate limit com o Redis fora do ar antes de cair para o limitador local. Na repetição, a fase de falha de worker também teve latências mais altas (leitura p95 38,7 ms contra 10,0 ms na execução completa), coincidindo com a recompilação do processo do worker no mesmo host. Também não isolado. Os dois casos continuam dentro das metas.

## 5. Comparação com a baseline e com as metas D4

Baseline (D4): a primeira execução completa registrada é a `qmw9y8c2g` (`qualification-2026-11-09.json`). A fase `baseline` dentro dela (20 req/s por 120 s) é a referência de latência. Não havia execução anterior para comparar. Comparação dentro da execução: leitura p95 11,0 ms no baseline contra 5,8 ms na carga; escrita p95 20,7 ms contra 14,6 ms; p99 de leitura 14,6 ms contra 11,4 ms. A latência não subiu com a taxa entre 20 e 100 req/s, o que sugere que o baseline pegou o sistema menos aquecido. Não é uma regressão; a causa não foi isolada.

| Meta D4 | Medido (execução completa) | Veredito |
| --- | --- | --- |
| Carga 100 req/s por 10 min | 100,00 req/s de sucesso (60.000 de 60.000) | Atende |
| Leitura p95 ≤ 200 ms | 5,8 ms | Atende |
| Leitura p99 ≤ 500 ms | 11,4 ms | Atende |
| Escrita p95 ≤ 400 ms | 14,6 ms | Atende |
| Escrita p99 ≤ 800 ms | 21,9 ms | Atende |
| Erros não intencionais < 0,5% | 0,000% (0 de 60.000) | Atende |
| Repetições idempotentes sem efeito duplicado | 849 repetições na carga; 0 aceitas sem replay; no run inteiro, 4.902 repetições e 0 aceitas sem replay | Atende |
| Soak 50 req/s por 30 min, erros | 0 de 90.000 | Atende |
| Soak: crescimento de RSS por processo < 15% | api-a +0,05%; api-b −44,70%; worker-1 +3,83% | Atende |
| Soak: crescimento de heap por processo < 15% | api-a −1,01%; api-b **+19,32%**; worker-1 −34,82% | **Não atende** (api-b) |
| Saturação: 429/503 observáveis, sem fila ou memória ilimitadas | 429 observáveis (40 / 35.900 / 83.920), rejeição p99 4,4 ms, 0 timeouts, latência máxima 178 ms | Atende, com ressalva (ver seção 6) |
| Recuperação ≤ 30 s após sobrecarga | 0,00 s | Atende |
| Recuperação ≤ 30 s após SIGKILL de réplica | 1,00 s (tráfego de volta em 1,43 s) | Atende |
| Recuperação ≤ 30 s após indisponibilidade do Redis | 19,7 a 20,0 s, nas duas execuções | Atende, com margem de 10 s |
| Recuperação ≤ 30 s após SIGKILL de worker | 0,93 s (repetição; a execução completa tem valor inválido) | Atende |
| Recuperação ≤ 30 s após reinício do PostgreSQL | Não medido. Não estava no escopo pedido. | Não medido |
| Mistura 70% leitura / 30% escrita | 70,0% / 30,0% | Atende |
| Payload de escrita ≤ 2 KB | cerca de 150 bytes | Atende |
| 10 tenants | 10 tenants isolados | Atende |
| PATCH nas escritas | Não usado. A especificação pediu apenas `POST /contacts`. | Desvio declarado |

Sobre o heap do `api-b` (+19,32%): pelo critério de extremos, o item não atende. A análise robusta não indica crescimento. As medianas em 300–900 s e 1.200–1.800 s diferem 4,53%, e a tendência linear em 30 min dá +9,3% no heap. O RSS do `api-b` caiu de cerca de 330 MiB para 226 MiB. O heap oscila entre cerca de 63 e 116 MB em todos os processos. O resultado do critério é uma amostra pontual, sensível a coleta de lixo. Não descartei amostras nem mudei o critério. O item segue como não atende, e um soak mais longo ou com amostragem repetida seria a forma de confirmar.

## 6. Achados

1. **Recuperação do Redis ~20 s.** O cliente de fila do BullMQ usa, por padrão, `retryStrategy = max(min(exp(n), 20000), 1000)` ms (`bullmq/dist/cjs/classes/redis-connection.js`). Depois de uma indisponibilidade de 20 s, a próxima tentativa de reconexão pode demorar até 20 s após o retorno. Por isso a outbox ficou parada cerca de 18 s após o retorno e zerou logo depois, em ambas as execuções. Na fumaça, com 10 s de corte, a recuperação foi de 0,67 s. Isso é comportamento de biblioteca, não bug do código do produto. Vale considerar uma política de reconexão mais curta em produção, mas não alterei o código.
2. **Limite de admissão.** O teto sustentado de 200 req/s é consequência da política de rate limit do teste (20 req/s por tenant), não de capacidade medida da máquina. A capacidade bruta observada foi de pelo menos 400 req/s sem rejeição.
3. **Profundidade da fila de admissão não é medida diretamente.** `admission.md` registra que a profundidade da fila não tem gauge no catálogo. "Sem fila ilimitada" foi inferido pela latência de rejeição (p99 4,4 ms) e pela latência máxima (178 ms), não por leitura da fila.
4. **Medição de recuperação na execução completa.** A versão inicial do harness media o término de `falha-worker` e `falha-redis` como se fosse o momento da recuperação. Isso deu 30,5 s no worker, que coincidia com o fim da fase. Corrigi a medição para observar o backlog a cada 250 ms durante a fase e repeti as três falhas com o mesmo protocolo. O valor de 30,5 s do worker foi descartado e não é usado nas metas. Os valores de Redis da execução completa (19,996 s) são de uma medição que só checava a outbox zerada, e batem com a repetição (19,74 s).
5. **Efeito único preservado** em todas as falhas: 0 contatos com indexação diferente de uma, 0 eventos de outbox diferentes de um e 0 mensagens de inbox duplicadas, nas duas execuções.

## 7. O que NÃO pode ser extrapolado para produção

- Tudo roda em uma máquina, no mesmo host: gerador de carga, duas réplicas, worker, PostgreSQL, Redis e a VM do Docker dividem 10 CPUs e 15 GiB. Não há rede real, latência entre hosts nem disco de servidor.
- Docker Desktop no macOS: a E/S de contêiner e o fsync do PostgreSQL diferem de Linux em servidor.
- Uma única instância de PostgreSQL e de Redis, sem replicação, sem failover e sem TLS.
- Carga sintética: um subject por tenant, payload fixo, sem autenticação de provedor real (usa os dublês do harness).
- Política de rate limit escolhida para o teste (20 req/s por tenant). Outra política muda o ponto de rejeição.
- Uma única execução completa e uma repetição das falhas. Não há intervalo de confiança entre execuções. Houve variação entre a execução completa e a repetição, como as latências de falha de worker e a recuperação do Redis.
- Soak de 30 min. Não diz nada sobre vazamentos que aparecem em horas ou dias.
- PostgreSQL restart não foi exercitado. Também não foi medido o comportamento da outbox quando o banco cai.
- Nenhuma alegação de capacidade de produção, de SLO ou de dimensionamento. Este documento é a linha de base local do perfil D4 e serve para comparar execuções futuras na mesma máquina.

## 8. Arquivos e alterações

Criados:

- `contacts/test/load/load.ts`: gerador open-loop, mistura, retentativa de transporte, estatística por classe e por segundo.
- `contacts/test/load/run-qualification.ts`: orquestrador (contêineres, proxy TCP do Redis, processos, fases, falhas, memória, consistência, metas, JSON).
- `contacts/test/load/results/*.json`: resultados (ver topo).
- `foundation-api/docs/qualification-2026-11-09.md`: este relatório.

Alterados (harness, sem código de produção):

- `contacts/test/vertical/runners/common.ts`: campos opcionais `admission` e `memSampleMs`, 10 identidades de carga, validade das sessões de teste de 1 h para 6 h, marca `MEM`.
- `contacts/test/vertical/runners/api-replica.ts`: admissão e rate limit compostos só quando `config.admission` existe, marca `MEM`, validade de 6 h.
- `contacts/test/vertical/runners/worker.ts`: marca `MEM`.
- `contacts/package.json`: script `qual:load`.

Não alterados: `openspec/`, `src/` de `contacts` e `foundation-api/src/`.

Um arquivo `contacts/test/load/results/baseline.json` apareceu durante a execução, com o `runId` da execução completa. Ele não foi escrito pelo harness deste trabalho. Não o alterei nem o apaguei. Ele aponta `foundation-api/docs/qualification.md` como relatório, enquanto o relatório pedido é este arquivo.

## 9. Comandos

```
cd contacts
QUAL_SMOKE=1 npm run qual:load                # fumaça 1: todas as fases, 30 s
QUAL_SMOKE=1 npm run qual:load                # fumaça 2: com rampa de saturação
QUAL_SMOKE=1 QUAL_FALHAS=1 npm run qual:load  # fumaça 3: só falhas
perl -e 'alarm 4200; exec @ARGV' npm run qual:load              # completa (~50 min)
QUAL_FALHAS=1 perl -e 'alarm 1200; exec @ARGV' npm run qual:load  # repetição das falhas
```

Exit codes das execuções de carga: fumaça 1, fumaça 2, fumaça 3, execução completa e repetição das falhas terminaram com 0. A consistência de cada execução foi `ok: true`.

Validação de regressão (em `contacts/`):

| Comando | Exit code | Resultado |
| --- | --- | --- |
| `npm run typecheck` | 0 | sem erros |
| `npm test` | 0 | 11 suítes, 142 testes aprovados |
| `npm run test:boundaries` | 0 | verificação de fronteiras e testes do script aprovados |
| `npm run test:vertical` | 0 | teste vertical com os runners alterados passa |

Ao final, não restou nenhum contêiner (inclusive o Ryuk) nem processo do teste.
