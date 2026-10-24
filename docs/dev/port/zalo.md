# Port manifest: zalo (AGPL-3.0)

Generated from GỐC `claudeclaw-os` (working tree, upstream = `upstream/main`). Machine-readable: `zalo.json`.

Scope: src/zalo/** + src/customer-care/connectors/zalo/** + web Zalo/Marketing files.

## Counts

| Item | Files | LOC |
|---|---:|---:|
| Kept (entries) | 94 | 22071 |
| - backend (modules/zalo/server) | 71 | 17267 |
| - web | 23 | 4804 |
| - skills | 0 | 0 |
| Tests kept (*.test.ts[x]) | 30 | 6371 |
| Test-support/fixture files kept | 3 | 494 |
| Moved in from another module's source dir | 19 | 4795 |
| Dropped | 21 | 5071 |
| - of which tests dropped | 11 | |

Classes: A=26, B=55, D=13. (C = upstream files to rewrite; see the table at the bottom and compat-symbols.md.)

Kind rules used: A = no import resolving to an upstream file, another module, or an owner-core file outside every manifest; B = otherwise (rewire needed); D = ZaloCRM-derived (zalo only). Imports to core-web files keep their `@/` path and do not count as cross-module.

## db.ts sections to extract (not files; extract-db-sections.mjs)

| Marker | db.ts line | region LOC |
|---|---:|---:|
| @zalo-schema:protection | 413 |  |
| @zalo-schema:templates | 430 |  |
| @zalo-schema:group-broadcast | 452 |  |
| @zalo-schema:list-broadcast | 515 |  |
| @zalo-schema:birthday | 575 |  |
| @zalo-schema:care-inbox | 620 |  |
| @zalo-migrations:protection | 1555 |  |
| @zalo-migrations:birthday | 1566 |  |
| @zalo-migrations:care-inbox | 1571 |  |
| @zalo-db:care-inbox | 3981 | 34 |
| @zalo-db:protection | 4015 | 162 |
| @zalo-db:templates | 4177 | 138 |
| @zalo-db:group-broadcast | 4315 | 350 |
| @zalo-db:list-broadcast | 4665 | 406 |
| @zalo-db:birthday | 5071 | 365 |

**Extraction pitfall:** 3 db.ts exports sit inside a marker region of another module: getZaloCustomerCare (line 8834, inside @fbstudio-db:ads, belongs to zalo); saveZaloCustomerCare (line 8841, inside @fbstudio-db:ads, belongs to zalo); zaloThreadHasCustomer (line 8862, inside @fbstudio-db:ads, belongs to zalo). A marker-only extraction would hand these to the wrong module. Take them into the zalo store explicitly.

Plus the original `zalo_*` tables and query functions in db.ts that sit before the first `@zalo-db` marker (owner-written, unmarked; see compat-symbols.md section "owner-unmarked").

## ZaloCRM-derived files (class D, go in NOTICE)

The 15 listed files: agent-turn, birthday-schedule, birthday, content, gate, group-broadcast, history, ingest, limits, responder, rich-text, schedule, sender, session, template. Three of them (agent-turn, gate, responder) are dropped by the §5 drop list, so only 12 of the 15 remain; 13 files are class D in total (the rest mention "ZaloCRM" in their text).

- `zalo/birthday-schedule.ts` -> `modules/zalo/server/birthday-schedule.ts` (ZaloCRM-derived (BUILD-PLAN 15))
- `zalo/birthday.ts` -> `modules/zalo/server/birthday.ts` (ZaloCRM-derived (BUILD-PLAN 15))
- `zalo/content.ts` -> `modules/zalo/server/content.ts` (ZaloCRM-derived (BUILD-PLAN 15))
- `zalo/group-broadcast.ts` -> `modules/zalo/server/group-broadcast.ts` (ZaloCRM-derived (BUILD-PLAN 15))
- `zalo/history.ts` -> `modules/zalo/server/history.ts` (ZaloCRM-derived (BUILD-PLAN 15))
- `zalo/ingest.ts` -> `modules/zalo/server/ingest.ts` (ZaloCRM-derived (BUILD-PLAN 15))
- `zalo/limits.ts` -> `modules/zalo/server/limits.ts` (ZaloCRM-derived (BUILD-PLAN 15))
- `zalo/rich-text.ts` -> `modules/zalo/server/rich-text.ts` (ZaloCRM-derived (BUILD-PLAN 15))
- `zalo/schedule.ts` -> `modules/zalo/server/schedule.ts` (ZaloCRM-derived (BUILD-PLAN 15))
- `zalo/sender.ts` -> `modules/zalo/server/sender.ts` (ZaloCRM-derived (BUILD-PLAN 15))
- `zalo/session.ts` -> `modules/zalo/server/session.ts` (ZaloCRM-derived (BUILD-PLAN 15))
- `zalo/template.ts` -> `modules/zalo/server/template.ts` (ZaloCRM-derived (BUILD-PLAN 15))
- `web:pages/ZaloAccounts.tsx` -> `modules/zalo/web/pages/ZaloAccounts.tsx` (mentions ZaloCRM)

No kept file outside the zalo manifest mentions ZaloCRM.

## Drop list

- **BUILD-PLAN §5: care-delivery (old AI path; AI now goes through care)** (4 files)
  zalo/care-delivery-capture.test.ts, zalo/care-delivery-sender.test.ts, zalo/care-delivery.test.ts, zalo/care-delivery.ts
- **BUILD-PLAN §5: agent-turn (old AI path; AI now goes through care)** (3 files)
  zalo/agent-turn-run.test.ts, zalo/agent-turn.test.ts, zalo/agent-turn.ts
- **BUILD-PLAN §5: care-fence (old AI path; AI now goes through care)** (3 files)
  zalo/care-fence-marketing.test.ts, zalo/care-fence.test.ts, zalo/care-fence.ts
- **BUILD-PLAN §5: responder (old AI path; AI now goes through care)** (3 files)
  zalo/responder-owner-alerts.test.ts, zalo/responder.test.ts, zalo/responder.ts
- **BUILD-PLAN §5: daemon-care (old AI path; AI now goes through care)** (2 files)
  zalo/daemon-care.test.ts, zalo/daemon-care.ts
- **BUILD-PLAN §5: gate (old AI path; AI now goes through care)** (2 files)
  zalo/gate.test.ts, zalo/gate.ts
- **BUILD-PLAN §5: pages ZaloAgents, ZaloChat** (2 files)
  web:pages/ZaloAgents.tsx, web:pages/ZaloChat.tsx
- **BUILD-PLAN §5: routes-customer-care (Customer 360 already in care)** (1 files)
  zalo/routes-customer-care.ts
- **unreachable from kept zalo web roots (only used by dropped pages ZaloAgents/ZaloChat)** (1 files)
  web:components/zalo/Customer360.tsx

Note: 1 of the dropped files are NOT named in BUILD-PLAN §5; they were dropped by extension of a listed pattern, by reachability, or because the test only imports dropped code. Reasons say which. Review them.

## Dependency conflicts

### Kept file imports a dropped file (5 dropped files, 13 import sites)

Each is a wiring/call-site edit in the kept file (or a decision to keep the dropped file). Importer `file:line {symbols}`:

- `zalo/care-fence.ts` <- zalo/birthday.ts:43 {zaloFenceDenial}; zalo/daemon.ts:35 {sweepZaloInflight}; zalo/dashboard-routes.ts:59 {zaloFenceDenial}; zalo/group-broadcast.ts:44 {zaloFenceDenial}; zalo/history.ts:18 {zaloCareOwnsWrites}; zalo/ingest.ts:30 {zaloCareOwnsWrites}; zalo/list-broadcast.ts:42 {zaloFenceDenial}; zalo/sender.ts:45 {claimNextUnfencedZaloOutbox, zaloFence, zaloFenceBegin, zaloFenceEpoch}
- `zalo/daemon-care.ts` <- customer-care/connectors/zalo/daemon-test-kit.ts:7 {createCareControl, CareControl}; zalo/daemon.ts:36 {buildCareControl, CareControl}
- `zalo/responder.ts` <- zalo/daemon.ts:43 {ZaloResponder}
- `zalo/routes-customer-care.ts` <- zalo/dashboard-routes.ts:14 {registerZaloCustomerCareRoutes}
- `zalo/gate.ts` <- zalo/dashboard-routes.ts:61 {resolveAssignment, SKIP_REASON_LABEL, ZaloSkipReason}

### Kept tests that import a dropped file (1; kept so coverage of kept code is not lost, need edit)

- `zalo/customer-care.test.ts` -> `zalo/routes-customer-care.ts`

### Imports of another module's files (14 distinct target files)

- to **care** (14 files):
  - `customer-care/domain/types.ts` <- customer-care/connectors/zalo/normalize.ts, customer-care/connectors/zalo/zalo-connector.ts, customer-care/connectors/zalo/zalo-sync.test.ts, customer-care/connectors/zalo/zalo-test-kit.ts
  - `customer-care/connectors/contract.ts` <- customer-care/connectors/zalo/zalo-connector.test.ts, customer-care/connectors/zalo/zalo-connector.ts, customer-care/connectors/zalo/zalo-test-kit.ts
  - `customer-care/domain/errors.ts` <- customer-care/connectors/zalo/zalo-connector.ts
  - `customer-care/domain/checkpoint.ts` <- customer-care/connectors/zalo/zalo-connector.ts, customer-care/connectors/zalo/zalo-test-kit.ts
  - `customer-care/application/projector.ts` <- customer-care/connectors/zalo/zalo-normalize.test.ts
  - `customer-care/application/dispatch.ts` <- customer-care/connectors/zalo/zalo-outbox.test.ts
  - `customer-care/application/outbox-service.ts` <- customer-care/connectors/zalo/zalo-outbox.test.ts
  - `customer-care/application/ingest.ts` <- customer-care/connectors/zalo/zalo-test-kit.ts
  - `customer-care/persistence/index.ts` <- customer-care/connectors/zalo/zalo-test-kit.ts
  - `customer-care/test-fixtures.ts` <- customer-care/connectors/zalo/zalo-test-kit.ts
  - `web:components/care-channels/EditorShell.tsx` <- web:components/care-channels/zalo/ZaloAssignmentEditor.tsx
  - `web:components/care-channels/shared.tsx` <- web:components/care-channels/zalo/ZaloAssignmentEditor.tsx, web:components/care-channels/zalo/ZaloNickModals.tsx, web:pages/ZaloAccounts.tsx
  - `web:components/care/CareTabs.tsx` <- web:pages/MarketingBirthday.tsx, web:pages/MarketingGroupBroadcasts.tsx, web:pages/MarketingListBroadcasts.tsx, web:pages/MarketingTemplates.tsx
  - `web:components/care/CampaignTabs.tsx` <- web:pages/MarketingBirthday.tsx, web:pages/MarketingGroupBroadcasts.tsx, web:pages/MarketingListBroadcasts.tsx, web:pages/MarketingTemplates.tsx

### db.ts functions owned by another module (2)

- owned by **care**: getCareDbHandle(1)
- owned by **ads**: getZaloCustomerCare(1)

These functions live in the other module's extracted store; the importing module needs a provides/contract call or its own copy.

### Imports of owner-core files outside every manifest (0)

None.

### Advisory: kept non-test files imported only by dropped files (0)

None.

### Files assigned to this module by import reach (not under a module namespace): 1

web:components/TemplatePicker.tsx

## Upstream (class C) imports this module needs

25 upstream modules, 213 symbols. Format: symbol(number of kept files using it); a trailing dagger marks a symbol that does not exist in upstream/main (owner-added to an upstream file, extract it instead of rewriting). Signatures are in compat-symbols.md.

- `db.ts` (170): upsertZaloThread†(16), getZaloAccount†(16), _initTestDatabase(14), createZaloAccount†(14), getZaloThread†(10), getZaloProtectionSettings†(9), insertZaloMessage†(9), updateZaloAccountSettings†(9), getZaloTemplate†(8), createZaloTemplate†(7), setZaloThreadOptedOut†(7), listZaloAccounts†(7), saveZaloProtectionSettings†(6), getZaloBirthdayGreeting†(4), getZaloBirthdayThread†(4), insertZaloMedia†(4), updateZaloBirthdayGreeting†(4), getZaloMessages†(4), recordZaloThreadActivity†(4), getZaloBroadcast†(4), listZaloBroadcastTargets†(4), setZaloBroadcastState†(4), getZaloListBroadcast†(4), setZaloThreadBirthDate†(3), ZaloBirthdayConfig†(3), getZaloBirthdayConfig†(3), ZaloAccountRow†(3), deleteZaloAccount†(3), enqueueZaloOutbox†(3), updateZaloAccountState†(3), listZaloOutbox†(3), listZaloThreads†(3), ZaloMessageRow†(3), countZaloOutboundSince†(3), setZaloMessageRemoteIds†(3), createZaloBroadcast†(3), listZaloBroadcastRuns†(3), countZaloListRecipients†(3), listZaloListRecipients†(3), setZaloListBroadcastState†(3), updateZaloListRecipient†(3), getZaloMedia†(3), listZaloBirthdayGreetings†(2), saveZaloBirthdayConfig†(2), insertZaloBirthdayGreeting†(2), listZaloBirthdayGreetingsByBirthday†(2), ZaloBirthdayGreetingRow†(2), ZaloBirthdayOccasion†(2), failInterruptedZaloOutbox†(2), getZaloMessage†(2), approveZaloDraft†(2), countZaloThreads†(2), discardZaloDraft†(2), listZaloAssignments†(2), sanitizeZaloLimitOverrides†(2), searchZaloMessages†(2), setZaloThreadPause†(2), upsertZaloAssignment†(2), addZaloUsage†(2), countZaloBroadcastSince†(2), getZaloUsage†(2), getZaloAccountSession†(2), markZaloMessagesRecalled†(2), saveZaloAccountSession†(2), claimNextZaloBroadcastRun†(2), ZaloBroadcastInput†(2), finishZaloBroadcastRun†(2), updateZaloBroadcastTarget†(2), ZaloBroadcastRow†(2), ZaloBroadcastRunRow†(2), ZaloBroadcastTargetRow†(2), ZaloThreadRow†(2), createZaloListBroadcast†(2), listZaloListBatches†(2), requeueFailedZaloListRecipients†(2), ZaloListBroadcastInput†(2), countZaloListSent†(2), listZaloListBroadcasts†(2), ZaloListBroadcast†(2), ZaloListFilter†(2), getZaloMediaCache†(2), listZaloTemplates†(2), ZALO_BIRTHDAY_DEFAULTS†(1), countZaloBirthDateChecksSince†(1), countZaloBirthdayGreetingsDueBetween†(1), countZaloBirthdaySentBetween†(1), findZaloBirthdayThreads†(1), listDueZaloBirthdayGreetings†(1), listZaloBirthDateBackfillCandidates†(1), markZaloBirthDateChecked†(1), noteZaloThreadBirthDate†(1), retimePendingZaloBirthdayGreetings†(1), getCareDbHandle†(1), getZaloCustomerCare†(1), initDatabase(1), pruneZaloAgentRuns†(1), pruneZaloUsage†(1), countZaloDraftsByThread†(1), deleteZaloAssignment†(1), getZaloAssignment†(1), getZaloOutbox†(1), getZaloThreadByExternal†(1), listZaloAgentRuns†(1), markZaloThreadRead†(1), ZaloAssignment†(1), ZaloAssignmentMode†(1), ZaloAssignmentScope†(1), ZaloGroupTrigger†(1), claimNextZaloOutbox†(1), countZaloAgentReplies†(1), countZaloAgentRunsSince†(1), insertZaloAgentRun†(1), lastZaloHumanReplyAt†(1), getZaloBroadcastRun†(1), countZaloBroadcastTargets†(1), failInterruptedZaloBroadcastRuns†(1), hasOtherRunningZaloBroadcastRun†(1), hasZaloBroadcastRunStartedSince†(1), insertZaloBroadcastRun†(1), listScheduledActiveZaloBroadcasts†(1), setZaloBroadcastFailureCount†(1), setZaloBroadcastNextRun†(1), sweepZaloBroadcastRuns†(1), ZaloBroadcastRunState†(1), ZaloBroadcastTrigger†(1), ZaloSenderType†(1), ZaloLimitOverride†(1), ZaloProtectionSettings†(1), addZaloListRecipients†(1), closeDanglingZaloListBatches†(1), findZaloListCandidates†(1), finishZaloListBatch†(1), getZaloListThreadState†(1), listPendingZaloListRecipients†(1), markZaloListRecipientsSynced†(1), setZaloListBroadcastBatchOutcome†(1), startZaloListBatch†(1), ZaloListCandidate†(1), ZaloListRecipientRow†(1), deleteZaloMediaCache†(1), saveZaloMediaCache†(1), deleteZaloMediaRow†(1), isZaloMediaReferenced†(1), listUnreferencedZaloMedia†(1), ZaloMediaRow†(1), getZaloBirthdayStats†(1), ZaloBirthdayGreetingListRow†(1), ZaloBirthdayState†(1), deleteZaloBroadcast†(1), getLatestZaloBroadcastRun†(1), hasActiveZaloBroadcastRun†(1), listZaloBroadcasts†(1), updateZaloBroadcast†(1), deleteZaloListBroadcast†(1), skipZaloListRecipient†(1), skipZaloListRecipientsOutsideAccounts†(1), updateZaloListBroadcast†(1), getZaloListRecipient†(1), ZaloListRecipientState†(1), deleteZaloTemplate†(1), updateZaloTemplate†(1), ZaloTemplateInput†(1), ZaloTemplateRow†(1), deleteZaloMessage†(1), markZaloOutboxFailed†(1), markZaloOutboxSent†(1), ZaloOutboxRow†(1), findZaloAccountIdByUid†(1), ZaloAccountStatus†(1), saveTokenUsage(1)
- `web:lib/api.ts` (6): apiPost(9), apiPatch(4), apiDelete(4), apiPut(3), apiGet(2), tokenizedSseUrl(1)
- `config.ts` (5): STORE_DIR(3), (vi.mock)(3), *(3), ZALO_CONTROL_PORT†(2), PROJECT_ROOT(2)
- `agent-config.ts` (4): listAgentIds(2), resolveAgentClaudeMd(1), resolveAgentDir(1), loadAgentConfig(1)
- `kill-switches.ts` (3): isEnabled(1), KillSwitchDisabledError(1), requireEnabled(1)
- `provider.ts` (3): DEFAULT_PROVIDER(1), getMainProviderConfig(1), ProviderConfig(1)
- `platform.ts` (2): isProcessAlive(2), killProcess(1)
- `web:lib/useFetch.ts` (2): useFetch(13), invalidateFetchCache(4)
- `web:components/PageHeader.tsx` (2): PageHeader(5), Tab(2)
- `logger.ts` (1): logger(13)
- `crash-guard.ts` (1): (side-effect import)(1)
- `env.ts` (1): readEnvFile(3)
- `env-write.ts` (1): setEnvKey(1)
- `agent-engine/index.ts` (1): EngineFactory(1)
- `active-provider.ts` (1): defaultModelForProvider(1)
- `provider-registry.ts` (1): providerRunnable(1)
- `security.ts` (1): getScrubbedSdkEnv(1)
- `web:components/Toggle.tsx` (1): Toggle(5)
- `web:components/Modal.tsx` (1): Modal(4)
- `web:components/PageState.tsx` (1): PageState(10)
- `web:components/Pill.tsx` (1): Pill(10)
- `web:lib/toasts.ts` (1): pushToast(11)
- `web:components/ConfirmModal.tsx` (1): ConfirmModal(4)
- `web:lib/useDebounce.ts` (1): useDebouncedValue(1)
- `web:lib/format.ts` (1): formatRelativeTime(1)
