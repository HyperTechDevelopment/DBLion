<p align="center">
  <img src="./docs/assets/hero.svg" width="100%" alt="DBLion — o IDE de banco de dados com IA sob controle humano. A IA propõe. Você executa." />
</p>

<div align="center">
  <p>
    <a href="README.md">English</a> ·
    <a href="README.pt-BR.md"><strong>Português (BR)</strong></a>
  </p>
  <p>
    <a href="./ROADMAP.md"><img src="https://img.shields.io/badge/version-0.1.0-6d28d9?style=flat-square" alt="Versão 0.1.0" /></a>
    <a href="./ROADMAP.md"><img src="https://img.shields.io/badge/status-pre--1.0-f59e0b?style=flat-square" alt="Pré-1.0" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-16a34a?style=flat-square" alt="Licença MIT" /></a>
    <img src="https://img.shields.io/badge/platform-Windows%20x64-2563eb?style=flat-square" alt="Windows x64" />
    <img src="https://img.shields.io/badge/stack-Electron%20%2B%20React%20%2B%20TypeScript-0f172a?style=flat-square" alt="Electron, React e TypeScript" />
  </p>
</div>

<p align="center">
  <img src="./docs/assets/dblion-app.png" width="100%" alt="DBLion 0.1.0 em tela cheia: workspace com editor SQL, selo somente leitura, barra de conexões e barra de guarda" />
</p>

<p align="center"><sub>DBLion 0.1.0 em tela cheia — workspace SQL, execução guardada, planos e ferramentas de schema. A IA propõe, só você executa.</sub></p>

---

> **Status: 0.1.0, pré-1.0.** O modelo de segurança, os adapters e o pipeline de contexto da IA têm cobertura automatizada. A validação ao vivo em cada motor ainda é o critério de release. Veja [ROADMAP.md](./ROADMAP.md).

## Índice

| Para começar | Para entender o projeto |
| --- | --- |
| [Início rápido](#início-rápido) · [Bancos suportados](#bancos-suportados) · [O que você pode fazer](#o-que-você-pode-fazer) | [Modelo de segurança](#modelo-de-segurança) · [IA](#ia) · [Arquitetura](#arquitetura) |
| [Desenvolvimento e testes](#desenvolvimento-e-testes) · [Estrutura do projeto](#estrutura-do-projeto) | [Status e roadmap](#status-e-roadmap) · [Documentação](#documentação) |

## Visão geral

| Princípio | O que significa |
| --- | --- |
| **Humano no controle** | A IA rascunha SQL, explica planos e diagnostica; só uma pessoa executa um statement. |
| **Multi-banco** | PostgreSQL, MySQL/MariaDB, SQL Server, Firebird, SQLite, MongoDB e Redis sob o mesmo contrato de adapter. |
| **Leituras guardadas** | Leituras originadas da IA usam modo ou transação read-only imposta pelo banco quando disponível. |
| **Egresso inspecionável** | O payload exato do provedor, os blocos de schema e os dados amostrados aparecem antes de sair da máquina. |

## Início rápido

Requisitos: Node.js 22 ou superior, npm e uma sessão desktop. O instalador empacotado atualmente tem como alvo Windows x64.

1. Instale e abra o studio:
```bash
npm ci
npm run dev
```
2. Clique em **Add connection**, escolha o motor, teste e salve.
3. Escreva SQL ou pergunte ao copilot, revise a proposta e pressione <kbd>Ctrl</kbd>+<kbd>Enter</kbd> — nada executa sem você.

Gerar o app descompactado:

```bash
npm run build
npm run dist
```

Gerar o instalador Windows:

```bash
npx electron-builder --win nsis
```

Os artefatos ficam em `release/`. O instalador é `release/DBLion Setup <versão>.exe`. Essa pasta, `out/` e `node_modules/` são geradas e ignoradas pelo Git.

## Bancos suportados

| Motor | Consulta | Navegador de tabelas | Catálogo / DDL | Plano estimado | Edição de linhas | Import CSV |
| --- | --- | --- | --- | --- | --- | --- |
| PostgreSQL | Sim | Sim | Sim | Sim, mais `ANALYZE` | Sim | Sim |
| MySQL / MariaDB | Sim | Sim | Sim | Sim, mais `ANALYZE` | Sim | Sim |
| SQL Server | Sim | Sim | Sim | Sim, `SHOWPLAN_TEXT` | Sim | Não |
| Firebird | Sim | Sim | Sim | Sim | Não | Não |
| SQLite | Sim | Sim | Sim | Sim, `EXPLAIN QUERY PLAN` | Sim | Sim |
| MongoDB | Documentos | Coleções | — | — | — | — |
| Redis | Comandos | Chaves | — | — | — | — |

Notas:

- **Planos Firebird** usam `EXPLAIN` nativo no 6+ e `isc_info_sql_get_plan` no 2.5–5 quando o driver expõe. `EXPLAIN ANALYZE` nunca é oferecido no Firebird.
- **Planos SQL Server** usam `SHOWPLAN_TEXT` em conexão fixada; `ANALYZE` executaria a consulta e não é oferecido.
- **Edição de linhas e CSV no Firebird** estão desativados até o adapter ter transações com commit/rollback. Consultas, catálogo, DDL, diff e migrations funcionam.
- **CSV no SQL Server** desativado porque o adapter não tem caminho transacional atômico. Edições não são atômicas com a leitura de origem.
- **Sessões** disponíveis para PostgreSQL, MySQL e SQL Server. Encerramento usa IPC dedicado com token, nunca SQL livre.
- **Read-only** é no nível do banco para PostgreSQL, MySQL, SQLite e Firebird; SQL Server usa `ApplicationIntent=ReadOnly` quando disponível; MongoDB e Redis dependem da guarda do app. As grants do banco continuam sendo a fronteira final.

## Arquitetura

```mermaid
flowchart LR
  UI["React renderer"] -->|"typed IPC"| MAIN["Electron main"]
  MAIN --> GUARD["SQL guard + tokens"]
  GUARD --> ADAPTERS["Database adapters"]
  ADAPTERS --> DB[("PostgreSQL · MySQL · SQL Server<br/>Firebird · SQLite · MongoDB · Redis")]
  MAIN --> CTX["Schema + request context"]
  CTX --> AI["AI provider"]
  AI -.->|"proposal only"| UI
```

A IA recebe contexto e devolve texto. Ela não tem caminho até o banco; o único caminho de um statement até o motor é uma ação humana através da guarda.

## O que você pode fazer

### Workspace SQL

- Múltiplas abas de consulta, `Ctrl+Enter` roda a seleção ou o editor inteiro, e histórico persistente de 200 entradas.
- Resultados mostram as primeiras 5.000 linhas com aviso de truncamento; exportação salva CSV, JSON ou `INSERT` via diálogo nativo.
- Paginação no servidor, filtros e edição no Table Browser. Updates passam por preview, checagem de conflito e confirmação nativa.
- Plano estimado em árvore com custo, linhas e avisos. `EXPLAIN ANALYZE` só onde roda em transação read-only (PostgreSQL e MySQL).
- Import CSV com mapeamento de colunas, coerção de tipos, hash de conteúdo e transação única. Limites: 5 MB / 5.000 linhas.
- Schema explorer com tabelas, views, rotinas, triggers, índices, generators e domains onde o motor expõe.

### Interface

- Wizard de conexão por etapas (Motor → Geral → Opções → Revisão) com preview de URL, teste e save nativo.
- Tela de provedores de IA master–detail com cards, dicas de setup, presets de modelo/contexto e credenciais.
- Abas SQL, schema explorer, grafo ER, plano, table browser e painel de IA em uma janela.
- Temas e fontes empacotados; sem fetch remoto de fonte.

### Ferramentas de schema

- Catálogo e DDL para todo motor SQL. DDL de tabela reconstruída leva aviso de revisão.
- Diff entre duas conexões do mesmo motor, gerando migration só para revisão.
- Migrations salvas como `.sql` versionados. Salvar nunca executa nada.

### Copiloto de IA

- Chat com streaming, blocos SQL e ação **Run manually** revisável.
- Autocomplete Monaco com schema e inline completion opcional.
- Contexto de schema enxuto por request; ranking por nomes, colunas e comentários.
- Grafo ER, skills e preview de contexto.

## Modelo de segurança

| Camada | Controle |
| --- | --- |
| **Execução** | A IA nunca executa e não tem tool calling, MCP ou shell. SQL proposto só roda após ação humana. |
| **Read-only** | Read-only global é o padrão. Cada perfil tem seu modo de acesso, aplicado ao abrir a sessão. |
| **Leituras da IA** | PostgreSQL, MySQL e Firebird usam transação read-only; SQLite usa `PRAGMA query_only`. SQL Server cai no classificador e na guarda. |
| **Escritas** | Exigem toggle na toolbar, modo não-read da IA e confirmação nativa. Token único por SQL ou identidade de linha. |
| **Autoridade** | O main resolve segurança SQL, contexto e segredos. O renderer não fornece schema nem declara write permitido. |
| **Segredos** | Criptografia do SO via `safeStorage`; senhas, API keys e chaves SSH nunca chegam ao renderer, logs ou auditoria. |
| **Renderer** | `sandbox`, `contextIsolation`, sem `nodeIntegration`, CSP, navegação bloqueada e allowlist só para `http:`, `https:` e `mailto:`. |
| **Entrada não confiável** | Schema, comentários, skills e amostras ficam em blocos `<untrusted-*>`; spoofing de delimitador é neutralizado e segurança vem primeiro. |
| **Egresso** | Sem headers de atribuição ou telemetria. O painel Context mostra o payload exato; máscara PII opcional por perfil. |
| **Amostragem** | Aprovação por request, máscara PII, limites de linhas e token único de 60 segundos. |
| **Fronteira final** | As grants do banco. Use usuário de privilégio mínimo para leitura. |

Leia [SECURITY.md](./SECURITY.md) para a lista completa de invariantes e o processo de disclosure.

## IA

Provedores: OpenAI, Anthropic, Ollama, OpenRouter e endpoints custom OpenAI-compatible.

Cada perfil controla base URL, modelo, API key, janela de contexto, temperatura, limite de saída, timeout, streaming, compartilhamento de schema, máscara PII e instruções custom. O painel expõe system prompt e conversa exatos via **Context**; o preview nunca contém a API key.

Autocomplete e inline completion resolvem o schema a partir da **conexão viva no main**. O renderer não escolhe nem altera o schema enviado, e o toggle de autocomplete da IA é imposto no main.

<details>
<summary><strong>Caminhos de descoberta de skills</strong></summary>

O DBLion descobre `SKILL.md` recursivamente em:

- `~/.agents/skills`
- `~/.agents/.skills`
- `~/.commandcode/skills`
- `~/.claude/skills`
- `~/.config/opencode/skills`
- `~/.opencode/skills`
- `.agents/skills` e `.claude/skills` do projeto

Skills entram no system prompt como contexto não confiável. Com auto-select, a última mensagem é casada com nome/descrição. Leituras restritas às raízes descobertas.

</details>

## Dados para debug

O controle **Data** do painel anexa evidência a um request, nunca automático:

| Modo | O que o provedor recebe | Guardrails |
| --- | --- | --- |
| **Perfil de coluna** | Contagens, nulos, distintos, min/max e top 5 como hashes truncados | Colunas com nome de PII são redigidas |
| **Amostra de linhas** | No máximo 25 linhas de uma tabela | Read-only onde há, máscara PII e token único de 60 segundos |

Ambos mostram o bloco mascarado exato e emitem token único. Preview não consome; o próximo chat consome. MongoDB e Redis ficam de fora por não terem catálogo SQL.

PostgreSQL, MySQL, SQLite e Firebird impõem read-only no banco. SQL Server não tem switch transacional read-only, então o SELECT gerado segue gated pelo classificador e pela guarda.

## Onde ficam os dados

O app guarda runtime no `userData` do Electron. No Windows é `%APPDATA%\dblion`; no macOS/Linux, use o caminho do `userData`. Contém `dblion-state.json`, `dblion-secrets.json` (criptografado), `dblion-audit.jsonl` e `migrations/`. Nada disso vai para o repositório.

## Desenvolvimento e testes

| Área | Comando |
| --- | --- |
| Typecheck | `npm run typecheck` |
| SQL safety | `npm run test:safety` |
| Fronteira do renderer | `npm run test:security` |
| Adapter Firebird | `npm run test:firebird` |
| Catálogo/DDL Firebird | `npm run test:firebird-catalog` |
| Fila serial | `npm run test:serial-queue` |
| Paridade multi-banco | `npm run test:multi-db` |
| Segurança de dados | `npm run test:ai-data` |
| Cercas read-only | `npm run test:read-only` |
| Segurança da IA | `node --import ./scripts/lib/ts-alias-register.mjs scripts/ai-safety.test.mjs` |
| Build | `npm run build` |

Checks ao vivo são opcionais e leem URLs do ambiente:

```bash
DBLION_TEST_PG_URL=postgres://user:pass@host:5432/db
DBLION_TEST_MYSQL_URL=mysql://user:pass@host:3306/db
DBLION_TEST_MSSQL_URL=sqlserver://user:pass@host:1433/db
DBLION_TEST_FIREBIRD_URL=firebirdsql://user:pass@host:3050/path/to/db.fdb?encoding=UTF8
```

Sem URL, o check reporta `skipped`. O teste SQL Server espera role que crie tabelas de prova; senão explica o skip. Cobertura Firebird ao vivo: conexão, recusa de escrita, catálogo, índice de colunas e plano estimado.

## Estrutura do projeto

```text
src/main       Electron main: adapters, safety gates, AI context, storage
src/preload    Typed contextBridge surface
src/renderer   React UI, Monaco editor, schema explorer, AI panel
src/shared     Types, SQL classification, access policy, Firebird URL helpers
scripts        Automated test suites and test-only helpers
docs           Capability matrix, Firebird notes and README assets
```

Todo banco implementa `DbAdapter` em `src/main/db/types.ts`. Adicionar um significa um adapter, uma entrada em `src/main/db/index.ts` e testes de contrato. Veja [CONTRIBUTING.md](./CONTRIBUTING.md).

## Status e roadmap

DBLion está em **0.1.0, pré-1.0**. Invariantes de segurança e adapters multi-engine com testes; o gate restante é validação ao vivo em servidores reais, sobretudo Firebird 2.5/3/4/5/6.

Limites atuais:

- Edição de linhas e CSV no Firebird aguardam transações no adapter.
- DDL de tabela Firebird é reconstruída e marcada review-only; DDL de função não é gerada.
- CSV no SQL Server desativado, e row edits não são atômicos com a leitura.
- Instalador sem assinatura e sem auto-update.
- O instalador Windows é o alvo empacotado; outras plataformas não são testadas para release.

Veja [ROADMAP.md](./ROADMAP.md) para workstreams e gates.

## Documentação

| Documento | O que cobre |
| --- | --- |
| [ROADMAP.md](./ROADMAP.md) | Trabalho aberto, gates P0 e definition of done |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Setup, checks, contrato de adapter, invariantes e checklist de release |
| [SECURITY.md](./SECURITY.md) | Invariantes e disclosure privado |
| [LICENSE](./LICENSE) | Licença MIT |

## Contribuindo

Issues e PRs são bem-vindos. Mantenha mudanças pequenas, rode os checks acima e não enfraqueça as travas de execução sem discussão de design. Não commite estado local, credenciais ou build gerado.

## Licença

MIT — `SPDX-License-Identifier: MIT`. Veja [LICENSE](./LICENSE).

Copyright (c) 2026 DBLion contributors. Texto canônico MIT, sem modificação. Ao forkar ou redistribuir, mantenha os avisos de copyright e permissão em todas as cópias ou porções substanciais.

<div align="center"><sub>DBLion 0.1.0 · execução guardada · SQL multi-engine</sub></div>
