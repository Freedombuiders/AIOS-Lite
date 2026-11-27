# G3: xoá các loại agent cũ, Chợ Agent cũ (báo cáo)

Branch `hoanghd218/agenticos-cleanup`, commits `820894b` (code, docs), `9b01032` (screenshots), and the commit adding this file.

## Verification (run in the worktree)

- `npm run typecheck`: pass (exit 0).
- `npx vitest run`: 415 files, 4749 tests: **14 failed, 4732 passed, 3 skipped**, 0 unhandled errors. The 14 are exactly the known ones:
  web/src/lib/api.test.ts x5, modules/video/web/lib/video-edit/quick-api.test.ts x5, modules/video/server/create/creation.test.ts x1,
  src/recos/recos.test.ts x2 (same assertion as on main before G3), modules/crm/web/pages/CrmCustomer.test.tsx x1.
  Note: `src/packs/cloud-interop.test.ts` failed at file level on a fresh worktree (missing `fflate` in `cloud/node_modules`);
  I ran `npm ci` in `cloud/` (no file change) and it passes.
- Grep `grep -rniE "claude-code|codex exec|hermes|grok cli|agent-market|Chợ Agent" src web modules --include='*.ts' --include='*.tsx'`:

```
src/core/runtime-policy.ts:8:   LEGACY_RUNTIME_IDS = ['claude', 'codex', 'grok', 'hermes']        <- legacy-runtime attention text (labels)
src/core/runtime-policy.ts:11:  LEGACY_LABEL = { claude: 'Claude Code', … hermes: 'Hermes' }    <- legacy-runtime attention text (labels)
web/src/App.tsx:121:            { path: '/agent-market', component: ToBots }                  <- the required redirect to /bots
src/core/runtime-policy.test.ts:12, src/agents/agents.test.ts:116-117                         <- tests: a legacy agent.yaml loads / is refused
src/api/teams.test.ts:73-74, web/src/components/Sidebar.test.tsx:103, web/src/lib/nav.test.ts:6,11  <- tests: market route 404, nav entry gone
modules/radar/server/render/fixtures.ts:273,292, fixtures-data.ts:47                          <- sample news content about a third-party
                                                                                                 product "Hermes Agent", not our runtime
```
  The KOL/video media providers do not match this pattern at all (they say "codex" / "chatgpt", left untouched).
- App run (real API, no mock, ports 4480/5273, temp data dir, copy of `agents/` plus one `runtime: claude` agent):
  `GET /api/agents` = bot-cskh, bot-noi-dung, bot-tro-ly; `GET /api/agent-market` = 404; `POST /api/tasks` without agentId went to
  `bot-tro-ly` and failed with "Thiếu runtime_options.bot_id"; /agents and /agent-market land on /bots; no page errors.
- Screenshots (1440 px): `docs/dev/screenshots/g3-sidebar-nang-cao.png`, `g3-bots.png`, `g3-bots-legacy.png`,
  `g3-agent-market-redirect.png`, `g3-bot-runs.png`.
- Not run: e2e (Playwright suite), `node --test scripts/**`, provenance check.

## Files deleted

- `agents/assistant/agent.yaml`
- `agents/assistant/persona.md`
- `agents/coder/agent.yaml`
- `agents/coder/persona.md`
- `agents/demo/agent.yaml`
- `agents/demo/persona.md`
- `agents/main/agent.yaml`
- `agents/main/persona.md`
- `agents/researcher/agent.yaml`
- `agents/researcher/persona.md`
- `src/agent-market/catalog.ts`
- `src/agent-market/files.ts`
- `src/agent-market/service.test.ts`
- `src/agent-market/service.ts`
- `src/agent-market/templates-extra.ts`
- `src/runtimes/acp.test.ts`
- `src/runtimes/acp.ts`
- `src/runtimes/claude.test.ts`
- `src/runtimes/claude.ts`
- `src/runtimes/codex.test.ts`
- `src/runtimes/codex.ts`
- `src/runtimes/grok.test.ts`
- `src/runtimes/grok.ts`
- `src/runtimes/hermes.test.ts`
- `src/runtimes/hermes.ts`
- `src/runtimes/jsonl.test.ts`
- `src/runtimes/jsonl.ts`
- `src/runtimes/process.test.ts`
- `src/runtimes/process.ts`
- `src/runtimes/shared.test.ts`
- `test-fixtures/runtimes/fake-claude.mjs`
- `test-fixtures/runtimes/fake-codex.mjs`
- `test-fixtures/runtimes/fake-core.mjs`
- `test-fixtures/runtimes/fake-grok.mjs`
- `test-fixtures/runtimes/fake-hermes.mjs`
- `test-fixtures/runtimes/fake-mcp.mjs`
- `web/src/components/agents/AgentForm.tsx`
- `web/src/components/org-card.tsx`
- `web/src/components/org-viewport.tsx`
- `web/src/components/teams/MarketInstallDialog.tsx`
- `web/src/components/teams/RuntimeSelect.tsx`
- `web/src/lib/org-layout.test.ts`
- `web/src/lib/org-layout.ts`
- `web/src/lib/org-view.ts`
- `web/src/pages/AgentMarket.tsx`
- `web/src/pages/OrgChart.tsx`
- `web/src/pages/agents/AgentsPage.tsx`
- `test-fixtures/runtimes/events/{claude,codex,grok}-hello.jsonl`

## Features that disappear

1. Running an agent on Claude Code, Codex, Grok or Hermes (already refused since G1); their doctor checks, CLI path overrides
   (`commands`, `env` registry options), ACP client, JSONL parsing, process runner, child-env filtering (`buildChildEnv`,
   `carriesCoreValue`): no child process gets an agent turn any more.
2. Symlinking granted skills into `<workspace>/.claude/skills` (claude/grok only).
3. Chợ Agent: page, install dialog, `/api/agent-market` (catalog, preview, install), its owner route, mock routes, docs.
4. Generic Agents pages: list with cards, "Thêm agent" form, org chart (`/agents?layout=org`), agent overview/settings form
   (model, permission, context, reports_to, can_delegate, max_concurrent, budget, enabled), persona tab, "Lưu trữ agent" button.
   `/agents/:id` keeps Lượt chạy, Trò chuyện and Quyền, opened from the bot card ("Lượt chạy, quyền").
5. Gói Team install dialog: the "Runtime mặc định" selector (always genbot now).
6. compat: `getMainProviderConfig`, `DEFAULT_PROVIDER`, `DEFAULT_CLAUDE_MODEL`, `defaultModelForProvider`, `providerRunnable`
   (unused by modules); chat-v2 short labels for Codex/Hermes/ACP.
7. `AppConfig.allowedRuntimes` (now only `allowedRuntimes()` in runtime-policy).
8. Sample agents assistant, coder, demo, main, researcher (replaced by bot-cskh, bot-noi-dung, bot-tro-ly).

## Deviations and why

- Kept `src/runtimes/probe.ts` (only `probeRequest`: GenBot's "ping" check and the tests use it) and a trimmed `shared.ts`;
  `clip` moved there from the deleted `jsonl.ts`.
- `/agents/:id` keeps a **Quyền** tab besides runs and conversations: Đội AI · Bot has no other screen to change a bot's brain,
  module or integration grants after creation. "logs" read as the bot's conversations. Persona and budget editing are UI-less now
  (still editable in `agent.yaml` / `persona.md`).
- Teams `cskh-zalo-email` and `fb-content-studio` kept: all-genbot, and Gói Team installs them (teams tests pass). But their
  personas still describe reading files and Pancake MCP tools, which a GenBot bot cannot do: **owner decision** whether to rewrite or drop.
- Shipped bots use brain folder `cong-ty-b` (Trà Sen Việt), the template's example; ca-nhan and cong-ty-a are no longer granted to
  any shipped agent.
- Default agent for unassigned work: `src/agents/default-agent.ts` (Trợ lý bot when it has a key, else first GenBot bot with a key,
  else Trợ lý / first bot so the run explains the missing key). Exposed to modules as `ctx.agents.defaultId()`.
- Marketing (ported code) stores `'main'` in settings/rules as "the default agent": kept as an alias, resolved in
  `modules/marketing/server/agent-run.ts`, shown as "Bot mặc định (Trợ lý)". KOL/video treat an empty or no-longer-existing
  brain agent (e.g. a stored `'main'`) as the default bot; new KOL personas store `''`.
- Radar's X reader (`collectors/x-grok.ts`, off since G1, only reachable through test injection) left in place; comments reworded.
  Candidate for deletion with the radar X settings.
- Video "tạo video bằng trò chuyện" gate untouched (G1 behaviour).
- e2e: switched to `AIOS_MOCK=1` and a throw-away mock agent, /bots and the redirects; not run.
- docs/lessons 02 and 03 and parts of ARCHITECTURE still describe the old engines and sample agents; ARCHITECTURE §6, lesson 04 and
  runtime-verification.md got a "removed in G3" banner only.

## Needs a real account or a human

- Connecting real GenBot bots (bot id + key on each card) to see bot-tro-ly answer; until then unassigned tasks fail with the
  "chưa có mã bot / khoá" message and the command bar shows "Nối bot".
- On `git pull`, a checkout where the owner edited `agents/main` (or the other old samples) gets a modify/delete conflict; untouched
  copies are removed by git. `data/`, `workspaces/` and brain folders are not touched by this change.
- Decide on the two old team packages (above) and on removing radar's X reader.

## Files changed outside the core area

modules/video (turn.ts, kol-port.ts, director.ts, writer.ts, series.ts, test-ctx.ts, actions.test.ts), modules/kol (agent-turn,
strategist, captions, personas, types, web/lib/kol.ts), modules/marketing (agent-run.ts, analyst.ts, FbPages, FbCommentRules,
AgentChatPanel), modules/zalo (routes-templates.ts, index.ts, MarketingTemplates.tsx), modules/dream/server/label.ts,
modules/care/web/lib/care/useInboxExtras.ts, modules/care/web/components/care/inbox/BotPanel.tsx, modules/radar (types.ts comments,
collectors.test.ts strings), modules/_template/server/index.ts, src/setup/connect.ts, src/modules/compat/*, e2e/core.spec.ts,
playwright.config.ts, package.json (description only), docs (README, CAI-DAT, huong-dan-noi-genbot, OPEN-AGENTICOS-PLAN, API-teams,
HUONG-DAN-SU-DUNG, ARCHITECTURE, lessons/04, runtime-verification).
