# Brief for build agents (read fully before coding)

You are one of several agents building **AIOS-Lite** in parallel. AIOS-Lite is a teaching template: an agent OS where Claude Code, Codex, Grok and Hermes agents are declared, governed and given work, with add-on modules.

Repo: thư mục gốc AIOS-Lite. Node 22, TypeScript 5.9, ESM (NodeNext, `.js` import suffixes), better-sqlite3 (sync), Hono, zod 4, pino, Vitest 3. Web: Preact 10 + wouter-preact + Tailwind 4 + lucide-preact, alias `@/` = `web/src`, `@core/*` = `src/core/*` (type-only from web), `@modules/*` = `modules/*`.

## Read first

1. `docs/ARCHITECTURE.md`: the design. §5 covers access, §7 work, §9 modules.
2. `docs/dev/TASKS.md` Part 2: your task IDs and their "Xong khi" (done-when) criteria.
3. The contracts, which are **frozen**:
   - `src/core/types.ts`, `src/core/deps.ts` (factory names)
   - `src/runtimes/contracts.ts`, `src/access/contracts.ts`, `src/agents/contracts.ts`, `src/shared/contracts.ts`, `src/work/contracts.ts`
   - `src/modules/sdk.ts`, `src/modules/contracts.ts`
   - `web/src/module-host/contracts.ts`, `docs/dev/API.md`
4. Existing core helpers you must reuse:
   - `src/core/db.ts`: `openDb`, `migrateCore`, `applyMigrations`, `nowIso`, `parseJson`, `camelRow`
   - `src/core/config.ts`: `loadConfig`, `expandHome`
   - `src/core/env.ts`, `src/core/events.ts` (`createEventBus`, `AppEvent`), `src/core/log.ts`, `src/core/redact.ts`, `src/core/crypto.ts`
   - The core schema is in `src/core/migrations/001_core.ts`. Its tables are `tasks`, `task_comments`, `runs`, `run_events`, `schedules`, `conversations`, `messages`, `memories` (+fts), `brain_docs` (+fts), `board`, `audit_log`, `attention`, `modules`, `kv`.

## Hard rules

- **License.** Never open, copy or paraphrase files from upstream ClaudeClaw.
  - The source repo is `~/Developer/GitHub/claudeclaw-os` ("GỐC"). A file there is upstream if `git -C ~/Developer/GitHub/claudeclaw-os cat-file -e upstream/main:<path>` succeeds.
  - You may copy **owner-only** GỐC files only when your task says so, preferably with `node scripts/port/copy.mjs docs/dev/port/<id>.json`. That script refuses upstream files.
  - Paperclip (MIT, `~/Developer/GitHub/paperclip-reference`) may be copied. Add a line to `docs/dev/notices-pending.md` (append-only) naming the source file.
  - `npm test` runs `scripts/check-provenance.mjs`, which must stay at 0 hits.
- **Contracts are frozen.** Do not edit contract files, `src/core/*`, `package.json`, configs, or another agent's files.
  - If you need something extra, put it in your own files.
  - If the contract itself is wrong, describe the change in your final report. Do not change it yourself.
- **No `npm install`.** Installed packages:
  - runtime: hono, @hono/node-server, better-sqlite3, zod, yaml, croner, cron-parser, pino, zca-js, @composio/core, image-size, marked, dompurify, preact, wouter-preact, lucide-preact, @preact/signals
  - dev: typescript, vitest, jsdom, tsx, vite, tailwind
  - If you are missing one, use node built-ins or report it.
- **Factories, not singletons.** Every service is `createXxx(deps)` as listed in `src/core/deps.ts`, so tests can build it with `openDb(':memory:')` + `migrateCore`. No module-level DB handles, and no `process.env` reads outside config/env helpers. The exception is runtime adapters, which pass env to child processes.
- **Tests.**
  - Colocate `*.test.ts` next to the code, and use Vitest.
  - No network.
  - No real CLI calls, unless your task explicitly says "kiểm thật" (live check). Live checks use tiny prompts only.
  - For services owned by other agents, write small in-test fakes that implement the contract interfaces.
  - Run your tests with `npx vitest run <your paths>` and keep them green.
- **Language.** Code, identifiers and comments are in English; keep comments short and only where they help. Everything a user sees (UI text, error messages returned by the API, prompt text written for agents, docs) is in **Vietnamese with full diacritics**.
- **DB conventions.** snake_case columns ↔ camelCase TypeScript objects (`camelRow`). JSON columns hold text. Timestamps are ISO strings via `nowIso()`. Every mutation that the UI should see emits a bus event (`AppEvent`).
- **Security defaults.**
  - Default deny.
  - Never log secrets; use `redact*`.
  - Never put secrets into prompts.
  - The API binds 127.0.0.1.

## Ownership (P1)

| Agent | Owns (create/edit only these) |
|---|---|
| A · runtimes | `src/runtimes/**` (except `contracts.ts`), `docs/dev/runtime-verification.md`, `test-fixtures/runtimes/**` |
| B · agents/access/shared | `src/agents/**`, `src/access/**`, `src/shared/**` (except contracts), `agents/**`, `skills/**`, `brain/**`, `config/**` |
| C · work | `src/work/**` (except contracts), `src/main.ts` |
| D · modules/api/cli | `src/modules/**` (except `sdk.ts`, `contracts.ts`), `src/api/**`, `src/cli/**`, `modules/_template/**` |
| E · web | `web/src/**` (except `module-host/contracts.ts`), `web/public/**` |

## Final report (keep it under 400 words)

Include:
- Task IDs done, and any not done (with the reason).
- Files created.
- Files copied: GỐC path → target, class A/B, or Paperclip.
- Test command and result (counts).
- Live checks performed, with results.
- Contract problems or requests.
- Anything the coordinator must wire or decide.
