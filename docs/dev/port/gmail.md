# Port manifest: gmail

Generated from GỐC `claudeclaw-os` (working tree, upstream = `upstream/main`). Machine-readable: `gmail.json`.

Scope: src/email/** + src/customer-care/connectors/email/** + web Email files.

## Counts

| Item | Files | LOC |
|---|---:|---:|
| Kept (entries) | 34 | 8946 |
| - backend (modules/gmail/server) | 28 | 7856 |
| - web | 6 | 1090 |
| - skills | 0 | 0 |
| Tests kept (*.test.ts[x]) | 11 | 3568 |
| Test-support/fixture files kept | 3 | 481 |
| Moved in from another module's source dir | 13 | 3674 |
| Dropped | 21 | 4472 |
| - of which tests dropped | 9 | |

Classes: A=7, B=27, D=0. (C = upstream files to rewrite; see the table at the bottom and compat-symbols.md.)

Kind rules used: A = no import resolving to an upstream file, another module, or an owner-core file outside every manifest; B = otherwise (rewire needed); D = ZaloCRM-derived (zalo only). Imports to core-web files keep their `@/` path and do not count as cross-module.

## db.ts sections to extract (not files; extract-db-sections.mjs)

| Marker | db.ts line | region LOC |
|---|---:|---:|
| @email-schema | 642 |  |
| @email-migrations | 1562 |  |
| @email-schema | 8869 |  |
| @email-db | 8874 | 1000 |

## Drop list

- **care-delivery/care-fence (not in §5 list; extends it by mirroring the zalo drop): legacy-coexistence fence, imports dropped runtime/legacy-compat** (6 files)
  email/care-delivery.test.ts, email/care-delivery.ts, email/care-fence-recheck.test.ts, email/care-fence-sync.test.ts, email/care-fence.test.ts, email/care-fence.ts
- **BUILD-PLAN §5: responder (old AI path / notify)** (3 files)
  email/responder-owner-alerts.test.ts, email/responder.test.ts, email/responder.ts
- **unreachable from kept gmail web roots (only used by dropped pages EmailInbox/EmailAgents)** (3 files)
  web:components/email/EmailBody.tsx, web:components/email/InboxOutbox.tsx, web:components/email/InboxThread.tsx
- **BUILD-PLAN §5: agent-turn (old AI path / notify)** (2 files)
  email/agent-turn.test.ts, email/agent-turn.ts
- **BUILD-PLAN §5: gate (old AI path / notify)** (2 files)
  email/gate.test.ts, email/gate.ts
- **BUILD-PLAN §5: worker (old AI path / notify)** (2 files)
  email/worker.test.ts, email/worker.ts
- **BUILD-PLAN §5: pages EmailInbox, EmailAgents** (2 files)
  web:pages/EmailAgents.tsx, web:pages/EmailInbox.tsx
- **BUILD-PLAN §5: notify (old AI path / notify)** (1 files)
  email/notify.ts

Note: 9 of the dropped files are NOT named in BUILD-PLAN §5; they were dropped by extension of a listed pattern, by reachability, or because the test only imports dropped code. Reasons say which. Review them.

## Dependency conflicts

### Kept file imports a dropped file (5 dropped files, 9 import sites)

Each is a wiring/call-site edit in the kept file (or a decision to keep the dropped file). Importer `file:line {symbols}`:

- `email/care-fence.ts` <- email/routes.ts:60 {emailFenceDenial}; email/sender.ts:30 {claimDueUnfencedEmailOutbox, emailFenceBegin, emailFenceEpoch}; email/sync.ts:53 {emailCareOwnsWrites}
- `email/gate.ts` <- email/routes.ts:59 {resolveEmailAssignment}; email/serialize.ts:14 {EMAIL_SKIP_REASON_LABEL, EmailSkipReason}
- `email/notify.ts` <- email/sender.ts:32 {notifyEmailOwner}; email/sync.ts:56 {notifyEmailOwner}
- `email/responder.ts` <- email/routes.ts:62 {draftEmailNow}
- `email/worker.ts` <- email/routes.ts:68 {emailWorkerStatus, isEmailCareEnabled, setEmailCareEnabled, syncAccountNow}

### Kept tests that import a dropped file (5; kept so coverage of kept code is not lost, need edit)

- `email/coordinator-sync-atomicity.test.ts` -> `email/notify.ts`
- `email/routes.test.ts` -> `email/worker.ts`, `email/responder.ts`
- `email/sender.test.ts` -> `email/notify.ts`
- `email/sync-fault.test.ts` -> `email/notify.ts`, `customer-care/bridge/bridge-fixtures.ts`
- `email/sync.test.ts` -> `email/notify.ts`

### Imports of another module's files (13 distinct target files)

- to **care** (12 files):
  - `customer-care/domain/errors.ts` <- customer-care/connectors/email/email-connector.ts, customer-care/connectors/email/email-dispatch.test.ts, customer-care/connectors/email/email-sync.test.ts, customer-care/connectors/email/store.ts
  - `customer-care/domain/checkpoint.ts` <- customer-care/connectors/email/email-connector.ts, customer-care/connectors/email/email-transport.test.ts
  - `customer-care/domain/types.ts` <- customer-care/connectors/email/email-connector.ts, customer-care/connectors/email/normalize.ts, customer-care/connectors/email/test-harness.ts
  - `customer-care/connectors/contract.ts` <- customer-care/connectors/email/email-connector.ts, customer-care/connectors/email/email-dispatch.test.ts, customer-care/connectors/email/test-harness.ts
  - `customer-care/application/ingest.ts` <- customer-care/connectors/email/test-harness.ts
  - `customer-care/application/dispatch.ts` <- customer-care/connectors/email/test-harness.ts
  - `customer-care/application/outbox-service.ts` <- customer-care/connectors/email/test-harness.ts
  - `customer-care/persistence/schema.ts` <- customer-care/connectors/email/test-harness.ts
  - `customer-care/persistence/index.ts` <- customer-care/connectors/email/test-harness.ts
  - `customer-care/test-fixtures.ts` <- customer-care/connectors/email/test-harness.ts
  - `web:components/care-channels/shared.tsx` <- web:components/care-channels/email/EmailAccountParts.tsx, web:components/care-channels/email/EmailAssignmentEditor.tsx, web:pages/EmailAccounts.tsx
  - `web:components/care-channels/EditorShell.tsx` <- web:components/care-channels/email/EmailAssignmentEditor.tsx
- to **zalo** (1 files):
  - `zalo/limits.ts` <- email/time.ts

### db.ts functions owned by another module (0)

None.

### Imports of owner-core files outside every manifest (2)

Owner-written (not upstream) files that stay in AIOS-Lite core (BUILD-PLAN §0.2 lists them as class A/B core files) or were moved to core. Needed with the same API:

- `fbstudio/composio.ts` (moved to core src/access/composio.ts): ComposioAuthError, ComposioConnectionExpiredError, ComposioRateLimitError, (side-effect/mock), *, classifyComposioError, getComposio, hasComposioKey, listConnections, ComposioConnection (10 files)
- `composio-credentials.ts`: (side-effect/mock), readComposioKey (2 files)

### Advisory: kept non-test files imported only by dropped files (0)

None.

## Upstream (class C) imports this module needs

13 upstream modules, 97 symbols. Format: symbol(number of kept files using it); a trailing dagger marks a symbol that does not exist in upstream/main (owner-added to an upstream file, extract it instead of rewriting). Signatures are in compat-symbols.md.

- `db.ts` (81): getEmailAccount†(9), updateEmailAccount†(9), getEmailMessages†(7), upsertEmailAccountFromConnection†(7), insertEmailMessage†(6), _initTestDatabase(5), getEmailThreadByGmail†(5), enqueueEmailOutbox†(5), getEmailProtectionSettings†(5), upsertEmailThread†(5), EmailAccountRow†(5), getEmailSyncWindow†(4), getEmailOutbox†(4), getEmailThread†(4), listEmailAccounts†(4), listEmailOutbox†(4), recordEmailThreadActivity†(4), approveEmailDraft†(3), countEmailApiCallsSince†(3), countEmailSentSince†(3), deleteEmailAccount†(3), findEmailMessageByGmailId†(3), listEmailAgentRuns†(3), setEmailThreadOptedOut†(3), setEmailThreadPause†(3), upsertEmailAssignment†(3), EmailThreadRow†(3), (vi.mock)(2), *(2), cancelEmailPending†(2), claimDueEmailOutbox†(2), countEmailOutbox†(2), countEmailThreads†(2), DEFAULT_EMAIL_PROTECTION†(2), deleteEmailAssignment†(2), discardEmailOutbox†(2), insertEmailAgentRun†(2), lastEmailHumanReplyAt†(2), listEmailAccountAddresses†(2), listEmailAssignments†(2), listEmailThreads†(2), markEmailOutboxFailed†(2), markEmailOutboxSent†(2), markEmailThreadRead†(2), recordEmailApiCall†(2), returnEmailOutboxToDraft†(2), saveEmailProtectionSettings†(2), updateEmailAgentRunStatus†(2), EmailAccountStatus†(2), EmailCategory†(2), EmailProtectionSettings†(2), EmailThreadView†(2), EmailOutboxRow†(2), countEmailAgentReplies†(1), countEmailAgentRunsSince†(1), failInterruptedEmailOutbox†(1), getEmailMessage†(1), getEmailSetting†(1), listEmailThreadsAwaitingAgent†(1), pruneEmailAgentRuns†(1), pruneEmailApiCalls†(1), setEmailSetting†(1), setEmailThreadHandled†(1), EmailMessageInsert†(1), EmailAssignmentMode†(1), EmailAssignmentScope†(1), EmailDirection†(1), EmailOutboxStatus†(1), EmailRunStatus†(1), EmailSenderType†(1), EmailAttachmentMeta†(1), getEmailAssignment†(1), EmailAssignmentInput†(1), EmailAgentRunRow†(1), EmailAssignment†(1), EmailMessageRow†(1), EmailThreadListRow†(1), clearEmailSyncWindow†(1), runEmailAtomic†(1), saveEmailSyncWindow†(1), EmailSyncWindow†(1)
- `web:lib/api.ts` (4): apiPost(4), apiPatch(2), apiDelete(1), apiPut(1)
- `kill-switches.ts` (2): isEnabled(2), (vi.mock)(1)
- `logger.ts` (1): logger(4)
- `agent-config.ts` (1): listAgentIds(1)
- `web:components/Modal.tsx` (1): Modal(1)
- `web:lib/toasts.ts` (1): pushToast(3)
- `web:components/Toggle.tsx` (1): Toggle(2)
- `web:components/ConfirmModal.tsx` (1): ConfirmModal(2)
- `web:components/PageHeader.tsx` (1): PageHeader(1)
- `web:components/PageState.tsx` (1): PageState(1)
- `web:components/Pill.tsx` (1): Pill(1)
- `web:lib/useFetch.ts` (1): useFetch(1)
