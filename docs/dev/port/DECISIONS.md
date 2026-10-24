# Port decisions for P2 (coordinator, 24/10/2026)

These answer the 13 open points in `README.md`. P2 agents follow them; they are not up for debate.

1. **care-fence (zalo, gmail): drop it and replace the calls.**
   - In AIOS-Lite the agent writes to customers only through `care` → `CareChannel.send()`.
   - Manual sends, broadcasts and birthday messages go directly through the channel's own sender, which keeps its limits.
   - Every place that asked "who owns this write" now takes the direct path.
   - Remove fence state, and the tests that only covered the fence.
2. **zalo AI path: edit `daemon.ts` and `dashboard-routes.ts`; drop `responder`, `gate`, `agent-turn` and `routes-customer-care`.**
   - Keep the parts of `daemon-care` that feed inbound messages and outbound sends to `care`, and rename them to `care-bridge.ts`.
   - `care-bridge.ts` implements the care connector contract through `ctx.modules.get('care')`.
   - If `care` is not enabled, the daemon still stores messages for the marketing features, and AI never runs.
3. **gmail: keep `routes.ts`, `serialize.ts` and `test-fixtures.ts`.**
   - Remove their imports of `gate`, `responder`, `worker` and `care-fence`, and the routes for agent assignment.
   - `notify` becomes `ctx.attention.raise`.
4. **care wiring: rewrite `api/index.ts`, `api/context.ts`, `runtime/*`, `application/ingest.ts` and `application/agent-turn.ts`** so nothing imports a dropped file.
   - Delete Telegram, bridge, cutover, legacy-delivery and owner-alerts features completely.
   - Owner alerts become `ctx.attention.raise` items, with `link` set to the inbox thread.
   - Update the 15 affected kept tests.
5. **care ↔ channels: one direction only.**
   - **Shared contract:** `modules/_lib/care-kit/` (`types`, `errors`, `checkpoint`, `validation`, `contract`, plus `index.ts`) was copied from the owner's care domain by the coordinator. `care`, `zalo` and `gmail` all import those types and helpers from `_lib/care-kit`. `care` does not keep its own copies; those 5 files were moved to `drop` in `care.json`.
   - `care` exposes `provides.careChannels = { register(channel: CareConnector), unregister(id), ingest(...) }` using the kept `connectors/contract.ts` types.
   - `zalo` and `gmail` call `register` in `start()` when `ctx.modules.isEnabled('care')`, and `unregister` in `stop()`.
   - `care` never imports zalo or gmail code.
   - On the web, care renders channel-specific pieces through `useProvides('care.channelPanel')` and `useProvides('care.composerExtras')`. The zalo and gmail web modules provide them. Care web must not import `lib/zalo`, `lib/email` or `InboxUtils`; move what is shared into care's own lib, or ask the channel to provide it.
6. **marketing ↔ ads: no imports either way.**
   - Types both need go in `modules/_lib/fb-types.ts` (create it if needed; the first agent to need it creates it and the other imports it).
   - `notify` becomes `ctx.attention.raise` in each module.
   - Data crosses only through `provides`: marketing gives `{ topPosts(pageId?, days), pageInfo(pageId) }` and ads gives `{ summary(accountId?) }`.
   - DB tables: marketing owns `fb_settings`, `fb_pages`, `fb_content*`, `fb_post_metrics`, `fb_comment*` and `fb_api_usage`; ads owns `fb_ad_*` / `fb_ads_*`.
   - Settings that ads needs live in ads' own module settings.
7. **Composio: use `modules/_lib/composio.ts`, the owner helper adapted by the coordinator.**
   - Each module calls `configureComposio({ getApiKey: () => ctx.connections.secret('COMPOSIO_API_KEY'), mediaDir, log: ctx.log })` in `start()`.
   - Marketing also passes `budget`, backed by `fb_api_usage`.
   - Import it with a relative path, e.g. `../../_lib/composio.js` from `modules/<id>/server/...`.
   - The file's API (`execute`, `graphAsPage`, `graphProxy`, `listConnections`, `activeConnection`, the error classes, `FB_MEDIA_DIR`) is unchanged.
8. **Promotions to core-web are accepted.** This covers charts, `lib/marketing`, and `PlatformBadge`. Modules import them via `@/components/fb/charts/...`.
9. **Core never imports modules.** Agent E cuts those imports. Module data reaches the dashboard through `widgets`.
10. **core-web is pruned** to `docs/dev/port/core-web-lite.json` (Agent E).
11. **db.ts extraction**
    - Use `scripts/port/extract-db-sections.mjs` for the marker regions, then add the owner-written functions that sit outside markers. Find them with `git -C ~/Developer/GitHub/claudeclaw-os diff upstream/main -- src/db.ts`; use only added lines.
    - `getZaloCustomerCare`, `saveZaloCustomerCare` and `zaloThreadHasCustomer` (inside `@fbstudio-db:ads`) go to zalo. If care now owns customer profiles, drop them.
    - Every extracted store module receives the DB handle from compat `getDb()`, or from `ctx.db` passed in; it never opens its own.
    - Remove the `email` extraction's integration and MCP-hub tables (`integration_*`, `mcp_hub*`); they are not email.
12. **ZaloCRM NOTICE** lists every file under `modules/zalo/` that still mentions ZaloCRM, plus the 12 remaining derived files. `modules/zalo/LICENSE` is the AGPL-3.0 text.
13. **Owner additions to main.css:** Agent E reproduces them.

## Shared rules for every P2 agent

- **Copying**
  - Copy with `node scripts/port/copy.mjs docs/dev/port/<id>.json`.
  - If you correct the manifest (keep or drop a file), edit your manifest JSON first, so `PORTING.md` stays truthful.
- **Imports**
  - Copied backend code reaches the core only through the Module SDK (`ctx`) or `src/modules/compat`. It never imports `src/*` internals.
  - Use relative import paths with the `.js` suffix.
- **Tests**
  - Copied tests must pass.
  - Tests for removed features are deleted, with the reason logged in `PORTING.md`.
  - Tests that hit real Facebook, Zalo or Gmail are forbidden; use the existing fakes.
- **Agent turns** go through `ctx.agents.runLean`. Keep the module's JSON output contract (`{action, text, reason, …}`) and its validation.
- **Kill switches** become module settings declared in `module.json`.
- **`npm test`** must keep `check-provenance` at 0 hits.
