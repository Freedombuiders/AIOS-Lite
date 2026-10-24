# Port manifest: care (Customer Care)

Generated from GỐC `claudeclaw-os` (working tree, upstream = `upstream/main`). Machine-readable: `care.json`.

Scope: src/customer-care/** minus connectors/zalo and connectors/email (moved out) + web care files.

## Counts

| Item | Files | LOC |
|---|---:|---:|
| Kept (entries) | 312 | 57256 |
| - backend (modules/care/server) | 174 | 43717 |
| - web | 138 | 13539 |
| - skills | 0 | 0 |
| Tests kept (*.test.ts[x]) | 94 | 19922 |
| Test-support/fixture files kept | 9 | 1346 |
| Moved in from another module's source dir | 0 | 0 |
| Dropped | 162 | 33586 |
| - of which tests dropped | 61 | |

Classes: A=251, B=61, D=0. (C = upstream files to rewrite; see the table at the bottom and compat-symbols.md.)

Kind rules used: A = no import resolving to an upstream file, another module, or an owner-core file outside every manifest; B = otherwise (rewire needed); D = ZaloCRM-derived (zalo only). Imports to core-web files keep their `@/` path and do not count as cross-module.

Moved OUT of care (receiving manifest owns them): connectors/zalo and connectors/email backend files and care-channels/zalo, care-channels/email web files. Backend+web files received: zalo: 19, gmail: 13.

## Drop list

- **BUILD-PLAN §5: connectors/telegram*** (41 files)
  customer-care/connectors/telegram-bot/ai-gate.test.ts, customer-care/connectors/telegram-bot/ai-gate.ts, customer-care/connectors/telegram-bot/bot-admin.test.ts, customer-care/connectors/telegram-bot/bot-admin.ts, customer-care/connectors/telegram-bot/bot-connector.test.ts, customer-care/connectors/telegram-bot/bot-connector.ts, customer-care/connectors/telegram-bot/bot-transport.ts, customer-care/connectors/telegram-bot/fake-transport.ts, customer-care/connectors/telegram-bot/http-transport.test.ts, customer-care/connectors/telegram-bot/http-transport.ts, customer-care/connectors/telegram-bot/keys.ts, customer-care/connectors/telegram-bot/normalize.ts, customer-care/connectors/telegram-bot/store.ts, customer-care/connectors/telegram-bot/test-harness.ts, customer-care/connectors/telegram/fake-protocol.ts, customer-care/connectors/telegram/gramjs/adapter.test.ts, customer-care/connectors/telegram/gramjs/adapter.ts, customer-care/connectors/telegram/gramjs/client-port.ts, customer-care/connectors/telegram/gramjs/conformance/telegram-auth.gramjs.test.ts, customer-care/connectors/telegram/gramjs/conformance/telegram-dispatch.gramjs.test.ts, customer-care/connectors/telegram/gramjs/conformance/telegram-ingest.integration.gramjs.test.ts, customer-care/connectors/telegram/gramjs/conformance/telegram-sync.gramjs.test.ts, customer-care/connectors/telegram/gramjs/convert-errors.test.ts, customer-care/connectors/telegram/gramjs/convert.ts, customer-care/connectors/telegram/gramjs/errors.ts, customer-care/connectors/telegram/gramjs/fake-client.ts, customer-care/connectors/telegram/gramjs/index.ts, customer-care/connectors/telegram/gramjs/lazy-import.test.ts, customer-care/connectors/telegram/gramjs/real-client.test.ts, customer-care/connectors/telegram/gramjs/real-client.ts, customer-care/connectors/telegram/gramjs/spike-tool.test.ts, customer-care/connectors/telegram/keys.ts, customer-care/connectors/telegram/protocol.ts, customer-care/connectors/telegram/session-store.test.ts, customer-care/connectors/telegram/session-store.ts, customer-care/connectors/telegram/telegram-auth.test.ts, customer-care/connectors/telegram/telegram-connector.ts, customer-care/connectors/telegram/telegram-dispatch.test.ts, customer-care/connectors/telegram/telegram-ingest.integration.test.ts, customer-care/connectors/telegram/telegram-sync.test.ts, customer-care/connectors/telegram/test-harness.ts
- **BUILD-PLAN §5: bridge/ (migration bridge from legacy Zalo/email to care)** (24 files)
  customer-care/bridge/bridge-fixtures.ts, customer-care/bridge/bridge-stores.test.ts, customer-care/bridge/capture-and-catchup.test.ts, customer-care/bridge/capture.ts, customer-care/bridge/cli.test.ts, customer-care/bridge/cli.ts, customer-care/bridge/common.ts, customer-care/bridge/control.test.ts, customer-care/bridge/control.ts, customer-care/bridge/coordinator-resnapshot.test.ts, customer-care/bridge/email-bridge.test.ts, customer-care/bridge/email.ts, customer-care/bridge/ids.ts, customer-care/bridge/index.ts, customer-care/bridge/progress.test.ts, customer-care/bridge/progress.ts, customer-care/bridge/resnapshot.test.ts, customer-care/bridge/service.ts, customer-care/bridge/tick-events.test.ts, customer-care/bridge/tick.test.ts, customer-care/bridge/tick.ts, customer-care/bridge/types.ts, customer-care/bridge/zalo-bridge.test.ts, customer-care/bridge/zalo.ts
- **BUILD-PLAN §5: rehearsal/** (16 files)
  customer-care/rehearsal/core-kit.ts, customer-care/rehearsal/legacy-provider-fakes.ts, customer-care/rehearsal/rehearsal-kit.ts, customer-care/rehearsal/rehearsal-report.test.ts, customer-care/rehearsal/rehearsal-report.ts, customer-care/rehearsal/rehearsal.test.ts, customer-care/rehearsal/rpc-ledger.test.ts, customer-care/rehearsal/rpc-ledger.ts, customer-care/rehearsal/scenarios/ctx.ts, customer-care/rehearsal/scenarios/s1-backfill.ts, customer-care/rehearsal/scenarios/s2-races.ts, customer-care/rehearsal/scenarios/s3-cutover.ts, customer-care/rehearsal/scenarios/s4-uncertain.ts, customer-care/rehearsal/scenarios/s5-rollback.ts, customer-care/rehearsal/scenarios/s6-pause-restore.ts, customer-care/rehearsal/scenarios/s7-gaps.ts
- **telegram (extends §5 pattern api/dto-telegram*): telegram connector is dropped** (14 files)
  customer-care/api/routes-telegram-bot.ts, customer-care/api/routes-telegram.ts, customer-care/api/telegram-bot-dashboard.test.ts, customer-care/api/telegram-bot.test.ts, customer-care/api/telegram-dashboard.test.ts, customer-care/api/telegram-flow.test.ts, customer-care/api/telegram-port.ts, customer-care/api/telegram-test-kit.ts, customer-care/api/telegram.test.ts, customer-care/runtime/telegram-bot-runtime.test.ts, customer-care/runtime/telegram-control.ts, customer-care/runtime/telegram-factory.test.ts, customer-care/runtime/telegram-factory.ts, customer-care/runtime/telegram-runtime.test.ts
- **BUILD-PLAN §5: owner-alerts/ (replaced by ctx.attention.raise)** (12 files)
  customer-care/owner-alerts/actions.test.ts, customer-care/owner-alerts/actions.ts, customer-care/owner-alerts/bot-callbacks.test.ts, customer-care/owner-alerts/card.ts, customer-care/owner-alerts/core.ts, customer-care/owner-alerts/index.ts, customer-care/owner-alerts/prefs-routes.test.ts, customer-care/owner-alerts/prefs.ts, customer-care/owner-alerts/store.ts, customer-care/owner-alerts/test-kit.ts, customer-care/owner-alerts/tick.test.ts, customer-care/owner-alerts/tick.ts
- **BUILD-PLAN §5: lib/care/telegram*** (11 files)
  web:lib/care/telegramApi.ts, web:lib/care/telegramBot.ts, web:lib/care/telegramBotView.test.ts, web:lib/care/telegramBotView.ts, web:lib/care/telegramLogin.test.ts, web:lib/care/telegramLogin.ts, web:lib/care/telegramQr.test.ts, web:lib/care/telegramQr.ts, web:lib/care/telegramStatus.test.ts, web:lib/care/telegramStatus.ts, web:lib/care/useTelegramLogin.ts
- **BUILD-PLAN §5: bench/** (10 files)
  customer-care/bench/bench-utils.ts, customer-care/bench/check-build.mjs, customer-care/bench/fixtures.ts, customer-care/bench/packaging.test.ts, customer-care/bench/plan-utils.ts, customer-care/bench/query-plans.test.ts, customer-care/bench/read-bench.test.ts, customer-care/bench/route-auth.test.ts, customer-care/bench/scenarios.ts, customer-care/bench/write-bench.test.ts
- **BUILD-PLAN §5: legacy-delivery/** (8 files)
  customer-care/legacy-delivery/contract.ts, customer-care/legacy-delivery/fake-channel.ts, customer-care/legacy-delivery/index.ts, customer-care/legacy-delivery/ops.test.ts, customer-care/legacy-delivery/ops.ts, customer-care/legacy-delivery/reply-requests.test.ts, customer-care/legacy-delivery/reply-requests.ts, customer-care/legacy-delivery/test-kit.ts
- **telegram (extends §5 lib/care/telegram*): telegram bot UI, connector dropped** (6 files)
  web:components/care/telegram/TelegramChips.tsx, web:components/care/telegram/TelegramLoginModal.tsx, web:components/care/telegram/TelegramQr.tsx, web:components/care/telegram/TelegramSection.tsx, web:components/care/TelegramBotPanel.tsx, web:styles/care-telegram-bot.css
- **BUILD-PLAN §5: runtime/{cutover*,legacy-compat*,app-bridge*}** (5 files)
  customer-care/runtime/app-bridge.test.ts, customer-care/runtime/app-bridge.ts, customer-care/runtime/cutover.test.ts, customer-care/runtime/cutover.ts, customer-care/runtime/legacy-compat.ts
- **bridge (extends §5 pattern dto-bridge): bridge/ is dropped** (3 files)
  customer-care/api/bridge-dashboard.test.ts, customer-care/api/bridge.test.ts, customer-care/api/routes-bridge.ts
- **BUILD-PLAN §5: api/dto-telegram*, dto-bridge** (3 files)
  customer-care/api/dto-bridge.ts, customer-care/api/dto-telegram-bot.ts, customer-care/api/dto-telegram.ts
- **BUILD-PLAN §5: components/care/bridge/**** (3 files)
  web:components/care/bridge/BridgePanel.tsx, web:components/care/bridge/EnableDialog.tsx, web:components/care/bridge/UnbridgedBanner.tsx
- **bridge/cutover (extends §5 bridge drop): web side of dropped bridge/cutover** (3 files)
  web:lib/care/bridge.ts, web:lib/care/cutover.test.ts, web:lib/care/cutover.ts
- **legacy entrance for old Zalo/Email paths, driven by the bridge (extends §5 bridge drop)** (2 files)
  web:components/care/legacy/LegacyEntry.tsx, web:components/care/legacy/LegacyFrame.tsx
- **tests budgets/engine-hook (BUILD-PLAN: engine-hook dropped, core Engine checks budget)** (1 files)
  customer-care/application/agent-runner-budget.test.ts

Note: 29 of the dropped files are NOT named in BUILD-PLAN §5; they were dropped by extension of a listed pattern, by reachability, or because the test only imports dropped code. Reasons say which. Review them.

## Reinstated / promoted (decisions beyond the literal plan)

- `customer-care/connectors/telegram/ai-block.test.ts`: reinstated with ai-block.ts
- `customer-care/connectors/telegram/ai-block.ts`: reinstated: aiChannelGate/assertAiAllowedForChannel imported by kept agent-context, ingest, routes-drafts (40-line channel gate, no Telegram runtime deps); re-home under care domain/

## Dependency conflicts

### Kept file imports a dropped file (33 dropped files, 71 import sites)

Each is a wiring/call-site edit in the kept file (or a decision to keep the dropped file). Importer `file:line {symbols}`:

- `customer-care/legacy-delivery/contract.ts` <- customer-care/api/context.ts:16 {LegacyCareOps}; customer-care/api/index.ts:41 {LegacyCareOps}; customer-care/api/legacy-errors.ts:6 {LegacyDeliveryError}; customer-care/api/routes-drafts.ts:21 {parseLegacyIntentId}; customer-care/api/routes-reply.ts:17 {parseLegacyIntentId}; customer-care/api/routes-workflow.ts:11 {LegacyDeliveryError}; customer-care/workflow/index.ts:19 {LegacyCareOps}; customer-care/workflow/test-kit.ts:9 {LegacyAiChange, LegacyAiState, LegacyCareOps}; +1 more
- `customer-care/runtime/cutover.ts` <- customer-care/api/context.ts:15 {CutoverController}; customer-care/api/index.ts:19 {CutoverController}; customer-care/api/routes-runtime.ts:16 {CutoverOutcome}; customer-care/runtime/care-runtime.ts:48 {CutoverController, CutoverPrecondition, CutoverPorts}; customer-care/runtime/index.ts:7 {*}; customer-care/runtime/inflight-probe.ts:15 {CutoverCheckResult, CutoverContext, CutoverPrecondition, InflightCounts, InflightProbe}
- `customer-care/connectors/telegram-bot/keys.ts` <- customer-care/application/agent-turn.ts:31 {BOT_CONNECTOR_KIND}; customer-care/application/ingest.ts:43 {BOT_CONNECTOR_KIND}; customer-care/runtime/care-guard.ts:18 {BOT_CONNECTOR_KIND}; customer-care/runtime/care-runtime.ts:33 {BOT_CONNECTOR_KIND, BOT_CREDENTIAL_TYPE}; customer-care/runtime/handlers.ts:16 {BOT_CONNECTOR_KIND}
- `customer-care/connectors/telegram-bot/ai-gate.ts` <- customer-care/application/agent-turn.ts:30 {TelegramBotAiGateFn}; customer-care/application/ingest.ts:42 {TelegramBotAiGateFn}; customer-care/runtime/care-guard.ts:17 {TelegramBotAiGateFn}; customer-care/runtime/care-runtime.ts:30 {createTelegramBotAiGate, TelegramBotAiGate}
- `web:lib/care/telegramLogin.ts` <- web:components/care/ChatComposer.tsx:12 {telegramTitleParts}; web:components/care/ConversationPane.tsx:7 {telegramTitleParts}; web:components/care/ConversationRow.tsx:7 {telegramTitleParts}; web:pages/care/CareInbox.tsx:26 {telegramTitleParts}
- `customer-care/api/telegram-port.ts` <- customer-care/api/context.ts:7 {CareTelegramPort}; customer-care/api/index.ts:36 {CareTelegramPort}; customer-care/api/index.ts:49 {*}
- `customer-care/bridge/service.ts` <- customer-care/runtime/app-deps.ts:28 {CareBridgeService}; customer-care/runtime/care-runtime.ts:41 {CareBridgeService}; customer-care/runtime/inflight-probe.ts:13 {CareBridgeService}
- `web:components/care/bridge/BridgePanel.tsx` <- web:components/care-channels/ChannelCards.tsx:7 {statusText}; web:pages/care/CareChannels.tsx:4 {BridgePanel}; web:pages/care/CareInbox.tsx:4 {BridgePanel}
- `customer-care/api/dto-bridge.ts` <- web:components/care-channels/ChannelCards.tsx:20 {BridgeAccountDto, BridgeUiStatus}; web:lib/care/client.ts:8 {BridgeAccountDto, BridgeCatchUpResultDto, BridgeDetailDto, BridgeKind, BridgeLegacyLinkDto, BridgeListDto, BridgePlanDto, BridgeVerifyResultDto}; web:lib/care/unify.ts:14 {BridgeListDto}
- `customer-care/bridge/control.ts` <- customer-care/api/context.ts:13 {BridgeControl}; customer-care/api/index.ts:33 {BridgeControl}
- `customer-care/api/dto-telegram.ts` <- customer-care/api/index.ts:48 {*}; customer-care/api/qr-matrix.ts:8 {TelegramQrDto}
- `customer-care/runtime/telegram-factory.ts` <- customer-care/runtime/app-deps.ts:30 {withResolvedTelegramFactory}; customer-care/runtime/boot.ts:25 {withResolvedTelegramFactory}
- `customer-care/connectors/telegram/telegram-connector.ts` <- customer-care/runtime/care-runtime.ts:29 {TelegramCareConnector}; customer-care/runtime/handlers.ts:13 {TelegramCareConnector, TelegramSyncResult}
- `customer-care/connectors/telegram-bot/bot-connector.ts` <- customer-care/runtime/care-runtime.ts:31 {TelegramBotCareConnector}; customer-care/runtime/handlers.ts:15 {BotSyncResult, TelegramBotCareConnector}
- `web:components/care/telegram/TelegramSection.tsx` <- web:components/care-channels/AdvancedPanel.tsx:7 {TelegramAccountPanel}; web:pages/care/CareChannels.tsx:6 {TelegramToolbar}
- `web:components/care/telegram/TelegramChips.tsx` <- web:components/care/ConversationPane.tsx:6 {TelegramChips}; web:components/care/ConversationRow.tsx:6 {TelegramChips}
- `customer-care/api/routes-bridge.ts` <- customer-care/api/index.ts:32 {registerBridgeRoutes}
- `customer-care/api/routes-telegram.ts` <- customer-care/api/index.ts:35 {registerTelegramRoutes}
- `customer-care/api/routes-telegram-bot.ts` <- customer-care/api/index.ts:37 {registerTelegramBotRoutes, TelegramBotApiOptions}
- `customer-care/owner-alerts/prefs.ts` <- customer-care/api/routes-prefs.ts:11 {ensureCarePrefsSchema, ownerAlertPrefsPatchSchema, readOwnerAlertPrefs, writeOwnerAlertPrefs}
- `customer-care/runtime/app-bridge.ts` <- customer-care/runtime/app-deps.ts:29 {createAppBridgeService}
- `customer-care/connectors/telegram-bot/http-transport.ts` <- customer-care/runtime/app-deps.ts:33 {defaultBotTransportFactory}
- `customer-care/runtime/telegram-control.ts` <- customer-care/runtime/boot.ts:24 {createTelegramControl}
- `customer-care/connectors/telegram/session-store.ts` <- customer-care/runtime/care-runtime.ts:27 {ensureTelegramSchema}
- `customer-care/connectors/telegram/protocol.ts` <- customer-care/runtime/care-runtime.ts:28 {TelegramProtocol}
- `customer-care/connectors/telegram-bot/bot-transport.ts` <- customer-care/runtime/care-runtime.ts:32 {BotTransportFactory}
- `customer-care/connectors/telegram-bot/store.ts` <- customer-care/runtime/care-runtime.ts:34 {ensureTelegramBotSchema}
- `customer-care/connectors/telegram/keys.ts` <- customer-care/runtime/handlers.ts:14 {boxOfPeer}
- `customer-care/runtime/legacy-compat.ts` <- customer-care/runtime/index.ts:6 {*}
- `web:lib/care/cutover.ts` <- web:components/care-channels/AdvancedPanel.tsx:17 {blockersFrom, cutoverActions, CutoverAction}
- `web:lib/care/bridge.ts` <- web:components/care-channels/ChannelCards.tsx:8 {bridgeList}
- `web:components/care/TelegramBotPanel.tsx` <- web:pages/care/CareChannels.tsx:7 {TelegramBotPanel}
- `web:components/care/bridge/UnbridgedBanner.tsx` <- web:pages/care/CareInbox.tsx:5 {UnbridgedBanner}

### Kept tests that import a dropped file (15; kept so coverage of kept code is not lost, need edit)

- `customer-care/ai-lockdown.test.ts` -> `customer-care/api/telegram-test-kit.ts`
- `customer-care/api/inbox-delivery.test.ts` -> `customer-care/legacy-delivery/index.ts`, `customer-care/legacy-delivery/test-kit.ts`
- `customer-care/api/runtime.test.ts` -> `customer-care/runtime/cutover.ts`
- `customer-care/api/workflow-routes.test.ts` -> `customer-care/legacy-delivery/contract.ts`
- `customer-care/db-wiring.test.ts` -> `customer-care/bridge/service.ts`, `customer-care/bridge/ids.ts`
- `customer-care/runtime/app-deps-bridge.test.ts` -> `customer-care/bridge/bridge-fixtures.ts`
- `customer-care/runtime/boot.test.ts` -> `customer-care/connectors/telegram/fake-protocol.ts`
- `customer-care/runtime/care-runtime.test.ts` -> `customer-care/runtime/legacy-compat.ts`
- `customer-care/runtime/core-ingest-isolation.test.ts` -> `customer-care/bridge/bridge-fixtures.ts`, `customer-care/bridge/ids.ts`, `zalo/care-fence.ts`
- `customer-care/runtime/first-cutover.test.ts` -> `customer-care/bridge/bridge-fixtures.ts`, `customer-care/bridge/ids.ts`
- `customer-care/runtime/gates.test.ts` -> `customer-care/runtime/legacy-compat.ts`
- `customer-care/runtime/legacy-holds-draft.test.ts` -> `customer-care/bridge/bridge-fixtures.ts`, `customer-care/bridge/ids.ts`, `email/care-fence.ts`, `zalo/care-fence.ts`
- `customer-care/runtime/legacy-holds.test.ts` -> `customer-care/bridge/bridge-fixtures.ts`, `customer-care/bridge/ids.ts`, `zalo/care-fence.ts`
- `customer-care/workflow/workflow.test.ts` -> `customer-care/legacy-delivery/contract.ts`
- `web:lib/care/unify.test.ts` -> `customer-care/api/dto-bridge.ts`

### Imports of another module's files (29 distinct target files)

- to **zalo** (18 files):
  - `customer-care/connectors/zalo/zalo-test-kit.ts` <- customer-care/connectors/connector-close.test.ts, customer-care/runtime/core-ingest-isolation.test.ts, customer-care/runtime/zalo-runtime.test.ts
  - `customer-care/connectors/zalo/daemon-transport.ts` <- customer-care/connectors/connector-close.test.ts, customer-care/runtime/app-deps.ts
  - `customer-care/connectors/zalo/fake-transport.ts` <- customer-care/runtime/boot.test.ts, customer-care/runtime/core-ingest-isolation.test.ts, customer-care/runtime/zalo-runtime.test.ts
  - `customer-care/connectors/zalo/zalo-connector.ts` <- customer-care/runtime/care-runtime.ts, customer-care/runtime/handlers.ts
  - `customer-care/connectors/zalo/normalize.ts` <- customer-care/runtime/care-runtime.ts
  - `customer-care/connectors/zalo/wire.ts` <- customer-care/runtime/care-runtime.ts
  - `customer-care/connectors/zalo/transport.ts` <- customer-care/runtime/care-runtime.ts
  - `customer-care/connectors/zalo/zca-transport.ts` <- customer-care/runtime/care-runtime.ts, customer-care/runtime/zalo-runtime.test.ts
  - `zalo/ingest.ts` <- customer-care/runtime/core-ingest-isolation.test.ts
  - `zalo/history.ts` <- customer-care/runtime/core-ingest-isolation.test.ts
  - `zalo/limits.ts` <- customer-care/runtime/legacy-holds.test.ts
  - `zalo/sender.ts` <- customer-care/runtime/legacy-holds.test.ts
  - `zalo/session.ts` <- customer-care/runtime/legacy-holds.test.ts
  - `web:lib/zalo.ts` <- web:components/care-channels/ChannelCards.tsx, web:components/care-channels/RulesSection.tsx, web:lib/care-channels/accounts.test.ts, web:lib/care-channels/accounts.ts, web:lib/care-channels/api.ts, ...
  - `web:components/care-channels/zalo/ZaloNickModals.tsx` <- web:components/care-channels/ChannelCards.tsx, web:pages/care/CareChannels.tsx
  - `web:components/care-channels/zalo/ZaloAssignmentEditor.tsx` <- web:components/care-channels/RulesSection.tsx
  - `zalo/customer-care-types.ts` <- web:lib/care/customer/adapters.ts, web:lib/care/customer/customer.test.ts
  - `web:components/ZaloServiceBanner.tsx` <- web:pages/care/CareChannels.tsx
- to **gmail** (11 files):
  - `customer-care/connectors/email/test-harness.ts` <- customer-care/connectors/connector-close.test.ts
  - `customer-care/connectors/email/gmail-transport.ts` <- customer-care/runtime/app-deps.ts
  - `customer-care/connectors/email/fake-transport.ts` <- customer-care/runtime/boot.test.ts, customer-care/runtime/email-runtime.test.ts
  - `customer-care/connectors/email/email-connector.ts` <- customer-care/runtime/care-runtime.ts, customer-care/runtime/email-runtime.test.ts, customer-care/runtime/handlers.ts
  - `customer-care/connectors/email/store.ts` <- customer-care/runtime/care-runtime.ts
  - `customer-care/connectors/email/transport.ts` <- customer-care/runtime/care-runtime.ts
  - `web:lib/email.ts` <- web:components/care-channels/ChannelCards.tsx, web:components/care-channels/RulesSection.tsx, web:lib/care-channels/accounts.test.ts, web:lib/care-channels/accounts.ts, web:lib/care-channels/api.ts, ...
  - `web:components/email/InboxUtils.ts` <- web:components/care-channels/ChannelCards.tsx, web:components/care/AttachmentList.tsx, web:components/care/ConversationRow.tsx, web:components/care/DraftReview.tsx, web:components/care/inbox/ComposerParts.tsx, ...
  - `web:components/care-channels/email/EmailAccountParts.tsx` <- web:components/care-channels/ChannelCards.tsx, web:pages/care/CareChannels.tsx
  - `web:components/care-channels/email/EmailAssignmentEditor.tsx` <- web:components/care-channels/RulesSection.tsx
  - `web:components/email/EmailServiceBanner.tsx` <- web:pages/care/CareChannels.tsx

### db.ts functions owned by another module (6)

- owned by **gmail**: getEmailProtectionSettings(1), approveEmailDraft(1), getEmailOutbox(1)
- owned by **zalo**: approveZaloDraft(1), getZaloOutbox(2), enqueueZaloOutbox(1)

These functions live in the other module's extracted store; the importing module needs a provides/contract call or its own copy.

### Imports of owner-core files outside every manifest (4)

Owner-written (not upstream) files that stay in AIOS-Lite core (BUILD-PLAN §0.2 lists them as class A/B core files) or were moved to core. Needed with the same API:

- `screen-context.ts`: parseScreenContext, buildScreenContextBlock (1 files)
- `agent-context.ts`: LEAN_CODEX_BASE_INSTRUCTIONS (1 files)
- `budgets/engine-hook.ts`: beginBudgetTurn (1 files)
- `system-backup.ts`: applySystemRestore, createSystemBackup, restoreWorkDir, stageSystemRestore, validateSystemBackup, BackupPaths (1 files)

### Advisory: kept non-test files imported only by dropped files (1)

- customer-care/api/qr-matrix.ts <- only customer-care/api/routes-telegram.ts

## Upstream (class C) imports this module needs

21 upstream modules, 44 symbols. Format: symbol(number of kept files using it); a trailing dagger marks a symbol that does not exist in upstream/main (owner-added to an upstream file, extract it instead of rewriting). Signatures are in compat-symbols.md.

- `db.ts` (8): getZaloOutbox†(2), *(1), getCareDbHandle†(1), getEmailProtectionSettings†(1), approveEmailDraft†(1), approveZaloDraft†(1), getEmailOutbox†(1), enqueueZaloOutbox†(1)
- `web:lib/api.ts` (8): apiGet(5), apiPost(3), apiPut(3), apiPatch(2), tokenizedSseUrl(2), apiFetch†(2), ApiError(1), apiDelete(1)
- `config.ts` (4): PROJECT_ROOT(1), (vi.mock)(1), *(1), DB_ENCRYPTION_KEY(1)
- `agent-engine/types.ts` (3): AgentEngine(4), AgentEngineEvent(3), AgentTurnInput(3)
- `provider.ts` (3): ProviderConfig(4), ProviderType(2), getMainProviderConfig(1)
- `agent-config.ts` (2): resolveAgentClaudeMd(1), loadAgentConfig(1)
- `web:components/PageHeader.tsx` (2): PageHeader(6), Tab(1)
- `agent-engine/claude-sdk-adapter.ts` (1): *(1)
- `agent-engine/openrouter-adapter.ts` (1): *(1)
- `active-provider.ts` (1): defaultModelForProvider(1)
- `env.ts` (1): readEnvFile(1)
- `provider-registry.ts` (1): providerRunnable(1)
- `security.ts` (1): getScrubbedSdkEnv(1)
- `web:components/Modal.tsx` (1): Modal(3)
- `web:components/Toggle.tsx` (1): Toggle(2)
- `web:lib/toasts.ts` (1): pushToast(16)
- `web:components/ConfirmModal.tsx` (1): ConfirmModal(5)
- `web:components/PageState.tsx` (1): PageState(12)
- `web:lib/format.ts` (1): resolveAgentName(2)
- `web:lib/useDebounce.ts` (1): useDebouncedValue(5)
- `web:lib/useFetch.ts` (1): useFetch(2)
