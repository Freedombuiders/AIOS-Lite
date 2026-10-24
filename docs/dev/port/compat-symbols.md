# Compat symbols (class C)

Union of upstream-file dependencies across the six manifests (care, zalo, gmail, marketing, ads, core-web). Every symbol is something kept code imports from a file that exists in `upstream/main`, so AIOS-Lite must provide it with the same API. Signatures were read from the exported declaration only (bodies elided).

**Surface: 36 upstream modules (19 backend, 17 web) and 447 distinct symbols (408 backend, 39 web).** Plus 26 CSS custom properties, 49 global classes and 5 Tailwind theme tokens from main.css.

db.ts: 366 symbols imported by kept files: n/a=2, owner-unmarked=55, owner-marker=306, upstream=3.

Legend for **Origin**: `upstream` = declared in upstream/main (rewrite in AIOS-Lite with this signature); `owner:@marker` = written by the owner inside a db.ts marker region (extract, do not rewrite); `owner-unmarked` = owner-written but outside any marker region (also extract); `n/a` = pseudo symbol (vi.mock, side-effect, namespace).

## Backend (src/)

| Module | Symbols | Kept files | Used by manifests |
|---|---:|---:|---|
| `db.ts` | 366 | 122 | care, gmail, zalo, marketing, ads |
| `config.ts` | 8 | 14 | care, zalo, marketing |
| `agent-config.ts` | 5 | 13 | care, zalo, marketing, gmail |
| `kill-switches.ts` | 5 | 20 | zalo, gmail, marketing |
| `provider.ts` | 4 | 7 | care, zalo, marketing |
| `agent-engine/types.ts` | 3 | 4 | care |
| `platform.ts` | 2 | 2 | zalo |
| `env-write.ts` | 2 | 2 | zalo, marketing |
| `agent-engine/index.ts` | 2 | 5 | zalo, marketing |
| `outbound-policy.ts` | 2 | 1 | marketing |
| `agent-engine/claude-sdk-adapter.ts` | 1 | 1 | care |
| `agent-engine/openrouter-adapter.ts` | 1 | 1 | care |
| `active-provider.ts` | 1 | 4 | care, zalo, marketing |
| `env.ts` | 1 | 6 | care, zalo, marketing |
| `provider-registry.ts` | 1 | 4 | care, zalo, marketing |
| `security.ts` | 1 | 4 | care, zalo, marketing |
| `logger.ts` | 1 | 35 | zalo, gmail, marketing, ads |
| `crash-guard.ts` | 1 | 1 | zalo |
| `outbound-sanitizer.ts` | 1 | 1 | marketing |

### `src/db.ts`

Generic upstream helpers (rewrite): 3. Owner-written inside `@…-db` markers (extract): 306. Owner-written outside markers (extract): 55. Other/pseudo: 2.

The owner-written functions are not compat work: `extract-db-sections.mjs` pulls them (with their `@…-schema` SQL) into each module's store. Only the generic helpers below need an AIOS-Lite implementation.

#### Generic upstream helpers (3)

| Symbol | Kept files | Example call sites | TypeScript signature |
|---|---:|---|---|
| `_initTestDatabase` | 38 | zalo/birthday.test.ts:195<br>zalo/customer-care.test.ts:15 | `export function _initTestDatabase(databasePath = ':memory:', opts: { key?: Buffer } = {}): void` |
| `saveTokenUsage` | 3 | zalo/variants.ts:180<br>fbstudio/analytics/agent-turn.ts:94 | `export function saveTokenUsage( chatId: string, sessionId: string \| undefined, inputTokens: number, outputTokens: number, cacheRead: number, contextTokens: number, costUsd: number, didCompact: boolean, agentId = 'main', contextWindow: number \| null = null, cacheCreation = 0, telemetry: { model?: string \| null; durationMs?: number; durationApiMs?: number; numTurns?: number; stopReason?: string \| null; isError?: boolean; costSource?: 'provider' \| 'unknown'; } = {}, ): void` |
| `initDatabase` | 1 | zalo/daemon.ts:60 | `export function initDatabase(): void` |

#### Owner-written in marker regions (306)

- owner:@email-db (78): DEFAULT_EMAIL_PROTECTION×2, EmailAccountRow×5, EmailAccountStatus×2, EmailAgentRunRow×1, EmailAssignment×1, EmailAssignmentInput×1, EmailAssignmentMode×1, EmailAssignmentScope×1, EmailAttachmentMeta×1, EmailCategory×2, EmailDirection×1, EmailMessageInsert×1, EmailMessageRow×1, EmailOutboxRow×2, EmailOutboxStatus×1, EmailProtectionSettings×2, EmailRunStatus×1, EmailSenderType×1, EmailSyncWindow×1, EmailThreadListRow×1, EmailThreadRow×3, EmailThreadView×2, approveEmailDraft×4, cancelEmailPending×2, claimDueEmailOutbox×2, clearEmailSyncWindow×1, countEmailAgentReplies×1, countEmailAgentRunsSince×1, countEmailApiCallsSince×3, countEmailOutbox×2, countEmailSentSince×3, countEmailThreads×2, deleteEmailAccount×3, deleteEmailAssignment×2, discardEmailOutbox×2, enqueueEmailOutbox×5, failInterruptedEmailOutbox×1, findEmailMessageByGmailId×3, getEmailAccount×9, getEmailAssignment×1, getEmailMessage×1, getEmailMessages×7, getEmailOutbox×5, getEmailProtectionSettings×6, getEmailSetting×1, getEmailSyncWindow×4, getEmailThread×4, getEmailThreadByGmail×5, insertEmailAgentRun×2, insertEmailMessage×6, lastEmailHumanReplyAt×2, listEmailAccountAddresses×2, listEmailAccounts×4, listEmailAgentRuns×3, listEmailAssignments×2, listEmailOutbox×4, listEmailThreads×2, listEmailThreadsAwaitingAgent×1, markEmailOutboxFailed×2, markEmailOutboxSent×2, markEmailThreadRead×2, pruneEmailAgentRuns×1, pruneEmailApiCalls×1, recordEmailApiCall×2, recordEmailThreadActivity×4, returnEmailOutboxToDraft×2, runEmailAtomic×1, saveEmailProtectionSettings×2, saveEmailSyncWindow×1, setEmailSetting×1, setEmailThreadHandled×1, setEmailThreadOptedOut×3, setEmailThreadPause×3, updateEmailAccount×9, updateEmailAgentRunStatus×2, upsertEmailAccountFromConnection×7, upsertEmailAssignment×3, upsertEmailThread×5
- owner:@zalo-db:templates (13): ZaloMediaRow×1, ZaloTemplateInput×1, ZaloTemplateRow×1, createZaloTemplate×7, deleteZaloMediaRow×1, deleteZaloTemplate×1, getZaloMedia×3, getZaloTemplate×8, insertZaloMedia×4, isZaloMediaReferenced×1, listUnreferencedZaloMedia×1, listZaloTemplates×2, updateZaloTemplate×1
- owner:@zalo-db:birthday (25): ZALO_BIRTHDAY_DEFAULTS×1, ZaloBirthdayConfig×3, ZaloBirthdayGreetingListRow×1, ZaloBirthdayGreetingRow×2, ZaloBirthdayOccasion×2, ZaloBirthdayState×1, countZaloBirthDateChecksSince×1, countZaloBirthdayGreetingsDueBetween×1, countZaloBirthdaySentBetween×1, findZaloBirthdayThreads×1, getZaloBirthdayConfig×3, getZaloBirthdayGreeting×4, getZaloBirthdayStats×1, getZaloBirthdayThread×4, insertZaloBirthdayGreeting×2, listDueZaloBirthdayGreetings×1, listZaloBirthDateBackfillCandidates×1, listZaloBirthdayGreetings×2, listZaloBirthdayGreetingsByBirthday×2, markZaloBirthDateChecked×1, noteZaloThreadBirthDate×1, retimePendingZaloBirthdayGreetings×1, saveZaloBirthdayConfig×2, setZaloThreadBirthDate×3, updateZaloBirthdayGreeting×4
- owner:@zalo-db:protection (11): ZaloLimitOverride×1, ZaloProtectionSettings×1, addZaloUsage×2, countZaloAgentRunsSince×1, countZaloBroadcastSince×2, getZaloProtectionSettings×9, getZaloUsage×2, pruneZaloUsage×1, sanitizeZaloLimitOverrides×2, saveZaloProtectionSettings×6, setZaloThreadOptedOut×7
- owner:@fbstudio-db:ads (26): FbAdAccountRow×9, FbAdsDailyInput×3, FbAdsDailyRow×2, FbAdsOrganicRow×1, FbAdsPlacementRow×2, FbAdsRecommendationRow×2, expireStaleFbAdsRecommendations×1, getFbAdAccount×9, getFbAdsRecommendation×2, getZaloCustomerCare×1, insertFbAdsRecommendation×1, listFbAdAccounts×8, listFbAdsDaily×4, listFbAdsOrganicRows×1, listFbAdsPlacements×2, listFbAdsRecommendations×4, markFbAdAccountSynced×2, pruneFbAdsData×1, recomputeFbAdsResults×1, replaceFbAdsPlacements×2, setFbAdAccountStatus×1, setFbAdsWindowFrequency×1, updateFbAdAccountSettings×6, updateFbAdsRecommendation×3, upsertFbAdAccount×6, upsertFbAdsDaily×3
- owner:@zalo-db:group-broadcast (29): ZaloBroadcastInput×2, ZaloBroadcastRow×2, ZaloBroadcastRunRow×2, ZaloBroadcastRunState×1, ZaloBroadcastTargetRow×2, ZaloBroadcastTrigger×1, claimNextZaloBroadcastRun×2, countZaloBroadcastTargets×1, createZaloBroadcast×3, deleteZaloBroadcast×1, failInterruptedZaloBroadcastRuns×1, finishZaloBroadcastRun×2, getLatestZaloBroadcastRun×1, getZaloBroadcast×4, getZaloBroadcastRun×1, hasActiveZaloBroadcastRun×1, hasOtherRunningZaloBroadcastRun×1, hasZaloBroadcastRunStartedSince×1, insertZaloBroadcastRun×1, listScheduledActiveZaloBroadcasts×1, listZaloBroadcastRuns×3, listZaloBroadcastTargets×4, listZaloBroadcasts×1, setZaloBroadcastFailureCount×1, setZaloBroadcastNextRun×1, setZaloBroadcastState×4, sweepZaloBroadcastRuns×1, updateZaloBroadcast×1, updateZaloBroadcastTarget×2
- owner:@zalo-db:list-broadcast (30): ZaloListBroadcast×2, ZaloListBroadcastInput×2, ZaloListCandidate×1, ZaloListFilter×2, ZaloListRecipientRow×1, ZaloListRecipientState×1, addZaloListRecipients×1, closeDanglingZaloListBatches×1, countZaloListRecipients×3, countZaloListSent×2, createZaloListBroadcast×2, deleteZaloListBroadcast×1, findZaloListCandidates×1, finishZaloListBatch×1, getZaloListBroadcast×4, getZaloListRecipient×1, getZaloListThreadState×1, listPendingZaloListRecipients×1, listZaloListBatches×2, listZaloListBroadcasts×2, listZaloListRecipients×3, markZaloListRecipientsSynced×1, requeueFailedZaloListRecipients×2, setZaloListBroadcastBatchOutcome×1, setZaloListBroadcastState×3, skipZaloListRecipient×1, skipZaloListRecipientsOutsideAccounts×1, startZaloListBatch×1, updateZaloListBroadcast×1, updateZaloListRecipient×3
- owner:@zalo-db:care-inbox (3): deleteZaloMediaCache×1, getZaloMediaCache×2, saveZaloMediaCache×1
- owner:@fbstudio-db:analytics (23): FbAnalyticsPageRow×4, FbAnalyticsPostRow×2, FbPageDailyRow×1, FbPostMetricsRow×2, countFbCommentsAnswered×2, countFbPostCommentsAnswered×2, getFbAnalyticsPage×6, getFbAnalyticsPostByFbId×3, getLastFbSnapshotAt×2, getLatestFbInsight×4, insertFbInsight×4, listFbAnalyticsPages×2, listFbAnalyticsPosts×6, listFbPageDaily×4, listFbPostMetrics×5, listFbPostMetricsForPost×3, listFbUnclassifiedImportedPosts×2, setFbAnalyticsPageFollowers×2, setFbAnalyticsPageStatus×2, setFbImportedClassification×2, upsertFbPageDaily×4, upsertFbPostMetrics×7, upsertImportedFbPost×4
- owner:@fbstudio-db:shared (3): countFbApiCallsSince×1, getFbSetting×11, setFbSetting×7
- owner:@fbstudio-db:comments (37): FbCommentLogRow×2, FbCommentPageRow×6, FbCommentRow×4, FbReplyTemplateRow×1, bumpFbReplyTemplateUses×1, claimFbCommentForSend×1, countFbRepliesDecidedSince×1, countFbRepliesToAuthorOnPost×1, deleteFbReplyRule×1, deleteFbReplyTemplate×1, fbCommentExists×1, getFbComment×7, getFbCommentForLog×2, getFbCommentPage×8, getFbCommentWatch×2, getFbPostText×1, getFbReplyRuleJson×1, getFbReplyTemplate×1, hasFbReplyToAuthorSince×1, insertFbCommentIfNew×2, insertFbReplyTemplate×3, isFbOwnReplyId×1, listFbCommentPages×1, listFbCommentsForLog×3, listFbCommentsSince×1, listFbDueComments×1, listFbNewComments×1, listFbPostOverridePostIds×1, listFbRecentPostsForRules×1, listFbReplyTemplates×3, listFbThreadComments×1, putFbReplyRule×2, setFbCommentPageStatus×3, topFbCommentTopics×1, updateFbComment×4, updateFbReplyTemplate×1, upsertFbCommentWatch×3
- owner:@fbstudio-db:core (28): FbContentRow×4, FbPageRow×5, claimFbContent×2, countFbContentByStatus×1, countFbSentReplies×1, deleteFbContentRow×1, expireFbPagesForConnection×1, getFbContent×8, getFbLatestPostMetrics×1, getFbPage×9, getFbPageWeekCounts×1, getLatestFbChannelInsight×1, getNextScheduledFbContent×1, insertFbContent×3, insertFbPublishLog×1, listDueFbContent×1, listFbCalendarRows×1, listFbContentRows×1, listFbOccupiedTimes×1, listFbPages×4, listFbPostsWithMetrics×1, listFbPublishLog×2, listStuckFbPublishing×1, releaseFbContentClaim×1, setFbPageStatus×2, updateFbContentFields×5, updateFbPageFields×8, upsertFbPageFromSync×5

#### Owner-written outside marker regions (zalo_* base functions etc.) (55)

- owner-unmarked (55): ZaloAccountRow×3, ZaloAccountStatus×1, ZaloAssignment×1, ZaloAssignmentMode×1, ZaloAssignmentScope×1, ZaloGroupTrigger×1, ZaloMessageRow×3, ZaloOutboxRow×1, ZaloSenderType×1, ZaloThreadRow×2, approveZaloDraft×3, claimNextZaloOutbox×1, countZaloAgentReplies×1, countZaloDraftsByThread×1, countZaloOutboundSince×3, countZaloThreads×2, createZaloAccount×14, deleteZaloAccount×3, deleteZaloAssignment×1, deleteZaloMessage×1, discardZaloDraft×2, enqueueZaloOutbox×4, failInterruptedZaloOutbox×2, findZaloAccountIdByUid×1, getCareDbHandle×2, getZaloAccount×16, getZaloAccountSession×2, getZaloAssignment×1, getZaloMessage×2, getZaloMessages×4, getZaloOutbox×3, getZaloThread×10, getZaloThreadByExternal×1, insertZaloAgentRun×1, insertZaloMessage×9, lastZaloHumanReplyAt×1, listZaloAccounts×7, listZaloAgentRuns×1, listZaloAssignments×2, listZaloOutbox×3, listZaloThreads×3, markZaloMessagesRecalled×2, markZaloOutboxFailed×1, markZaloOutboxSent×1, markZaloThreadRead×1, pruneZaloAgentRuns×1, recordZaloThreadActivity×4, saveZaloAccountSession×2, searchZaloMessages×2, setZaloMessageRemoteIds×3, setZaloThreadPause×2, updateZaloAccountSettings×9, updateZaloAccountState×3, upsertZaloAssignment×2, upsertZaloThread×16

#### Other (2)

| Symbol | Kept files | Example call sites | TypeScript signature |
|---|---:|---|---|
| `*` | 3 | customer-care/db-wiring.test.ts:42<br>email/coordinator-sync-atomicity.test.ts:10 | - |
| `(vi.mock)` (type) | 2 | email/coordinator-sync-atomicity.test.ts:9<br>email/gmail.test.ts:26 | - |

### `src/config.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `(vi.mock)` (type) (mocked) | n/a | 4 | customer-care/db-wiring.test.ts:14<br>zalo/dashboard-routes.test.ts:11 | - |
| `*` (type) | n/a | 4 | customer-care/db-wiring.test.ts:15<br>zalo/dashboard-routes.test.ts:12 | - |
| `PROJECT_ROOT` | upstream | 4 | customer-care/ai-lockdown.test.ts:214<br>zalo/dashboard-routes.ts:194 | `const PROJECT_ROOT = path.resolve(…)` |
| `STORE_DIR` | upstream | 3 | zalo/control.ts:15<br>zalo/media-cache.ts:20 | `const STORE_DIR = rawStoreDir ? expandHome(rawStoreDir) : path.resolve(PROJECT_ROOT, 'store')` |
| `ZALO_CONTROL_PORT` | owner-unmarked | 2 | zalo/control.ts:49<br>zalo/daemon.ts:275 | `const ZALO_CONTROL_PORT = parseInt(…)` |
| `AGENT_ID` | upstream | 1 | fbstudio/core/routes.ts:246 | `let AGENT_ID = 'main'` |
| `CLAUDECLAW_CONFIG` | upstream | 1 | fbstudio/comments/config.ts:146 | `const CLAUDECLAW_CONFIG = getClaudeclawConfig(…)` |
| `DB_ENCRYPTION_KEY` | upstream | 1 | customer-care/runtime/app-deps.ts:121 | `const DB_ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY \|\| envConfig.DB_ENCRYPTION_KEY \|\| ''` |

### `src/agent-config.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `listAgentIds` | upstream | 6 | zalo/dashboard-routes.ts:563<br>zalo/routes-templates.ts:233 | `export function listAgentIds(): string[]` |
| `loadAgentConfig` | upstream | 4 | customer-care/runtime/app-deps.ts:69<br>zalo/variants.ts:43 | `export function loadAgentConfig(agentId: string): AgentConfig` |
| `(vi.mock)` (type) (mocked) | n/a | 3 | fbstudio/comments/agent-turn-run.test.ts:7<br>fbstudio/core/pages.test.ts:20 | - |
| `resolveAgentClaudeMd` | upstream | 3 | customer-care/runtime/app-deps.ts:75<br>zalo/variants.ts:149 | `export function resolveAgentClaudeMd(agentId: string): string \| null` |
| `resolveAgentDir` | upstream | 3 | zalo/variants.ts:146<br>fbstudio/analytics/agent-turn.ts:63 | `export function resolveAgentDir(agentId: string): string` |

### `src/kill-switches.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `isEnabled` | upstream | 9 | zalo/dashboard-routes.ts:188<br>email/routes.ts:104 | `export function isEnabled(name: KillSwitch): boolean ‖ export type KillSwitch = \| 'WARROOM_TEXT_ENABLED' \| 'WARROOM_VOICE_ENABLED' \| 'LLM_SPAWN_ENABLED' \| 'DASHBOARD_MUTATIONS_ENABLED' \| 'MISSION_AUTO_ASSIGN_ENABLED' \| 'SCHEDULER_ENABLED' \| 'ZALO_AUTOREPLY_ENABLED' \| 'FB_PUBLISH_ENABLED' \| 'FB_AUTOREPLY_ENABLED' \| 'EMAIL_AUTOREPLY_ENABLED' \| 'KOL_GENERATE_ENABLED' \| 'KOL_PUBLISH_ENABLED';` |
| `(vi.mock)` (type) (mocked) | n/a | 7 | email/sender.test.ts:12<br>fbstudio/comments/agent-turn-run.test.ts:5 | - |
| `requireEnabled` | upstream | 3 | zalo/variants.ts:144<br>fbstudio/analytics/agent-turn.ts:61 | `export function requireEnabled(name: KillSwitch): void ‖ export type KillSwitch = \| 'WARROOM_TEXT_ENABLED' \| 'WARROOM_VOICE_ENABLED' \| 'LLM_SPAWN_ENABLED' \| 'DASHBOARD_MUTATIONS_ENABLED' \| 'MISSION_AUTO_ASSIGN_ENABLED' \| 'SCHEDULER_ENABLED' \| 'ZALO_AUTOREPLY_ENABLED' \| 'FB_PUBLISH_ENABLED' \| 'FB_AUTOREPLY_ENABLED' \| 'EMAIL_AUTOREPLY_ENABLED' \| 'KOL_GENERATE_ENABLED' \| 'KOL_PUBLISH_ENABLED';` |
| `_reset` | upstream | 2 | fbstudio/analytics/agent-turn.test.ts:16<br>fbstudio/analytics/analyst.test.ts:103 | `export function _reset(): void` |
| `KillSwitchDisabledError` | upstream | 2 | zalo/routes-templates.ts:246<br>fbstudio/analytics/agent-turn.test.ts:52 | `class KillSwitchDisabledError { constructor(public readonly switchName: KillSwitch) }` |

### `src/provider.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `ProviderConfig` (type) | upstream | 7 | customer-care/application/agent-runner-engine.test.ts:36<br>customer-care/application/agent-runner-engine.ts:51 | `export interface ProviderConfig { type: ProviderType; model?: string; runtimeMode?: ProviderRuntimeMode; thinkingMode?: ProviderThinkingMode; command?: string; args?: string[]; baseUrl?: string; endpoint?: OpenAiCompatEndpoint; dangerouslySkipPermissions?: boolean; }` |
| `getMainProviderConfig` | upstream | 4 | customer-care/runtime/app-deps.ts:67<br>zalo/variants.ts:41 | `export function getMainProviderConfig(): ProviderConfig` |
| `DEFAULT_PROVIDER` | upstream | 3 | zalo/variants.ts:47<br>fbstudio/analytics/agent-turn.ts:56 | `const DEFAULT_PROVIDER: ProviderConfig` |
| `ProviderType` (type) | upstream | 2 | customer-care/application/agent-runner-engine.test.ts:33<br>customer-care/runtime/app-deps.test.ts:39 | `export type ProviderType = 'harness' \| 'claude' \| 'acp' \| 'opencode' \| 'gemini' \| 'acp-codex' \| 'openrouter' \| 'openai' \| 'anthropic-compatible' \| 'hermes-gateway';` |

### `src/agent-engine/types.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `AgentEngine` (type) | upstream | 4 | customer-care/application/agent-runner-engine.test.ts:16<br>customer-care/application/agent-runner-engine.ts:63 | `export interface AgentEngine { invoke(input: AgentTurnInput): AsyncIterable<AgentEngineEvent>; }` |
| `AgentEngineEvent` (type) | upstream | 3 | customer-care/application/agent-runner-engine.test.ts:18<br>customer-care/application/agent-runner-engine.ts:200 | `export type AgentEngineEvent = \| { type: 'session'; sessionId: string; raw?: unknown } \| { type: 'text_delta'; delta: string; accumulatedText: string; raw?: unknown } \| { type: 'progress'; progress: AgentEngineProgressEvent; raw?: unknown } \| { type: 'usage'; usage: AgentEngineUsage; raw?: unknown } \| { type: 'compact'; preCompactTokens: number \| null; trigger?: string; raw?: unknown } \| ({ type: 'result'; text: string \| null; usage: AgentEngineUsage \| null; stopReason?: string; raw?: unknown } & AgentEngineErrorClassification) \| { type: 'aborted'; text: string \| null; sessionId?: string; usage: AgentEngineUsage \| null; raw?: unknown } \| ({ type: 'error'; error: unknown; raw?: unknown } & AgentEngineErrorClassification);` |
| `AgentTurnInput` (type) | upstream | 3 | customer-care/application/agent-runner-engine.test.ts:17<br>customer-care/application/agent-runner-engine.ts:175 | `export interface AgentTurnInput { codexAuthMode?: 'chatgpt'; hostTask?: 'video-create' \| 'video-produce'; harnessPlugins?: Array<{ id: string; entry: string; entryName?: string; files?: Record<string, string>; config: Record<string, unknown> }>; skillAgentId?: string; skillRestrictions?: boolean; skillPolicyFingerprint?: string; disabledSkillPaths?: string[]; prompt: string; provider: ProviderConfig; sessionId?: string; cwd: string; model?: string; runtimeMode?: string; thinkingMode?: string; effort?: 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'; thinking?: { type: 'adaptive' } \| { type: 'enabled'; budgetTokens?: number } \| { type: 'disabled' }; maxTurns?: number; maxBudgetUsd?: number; permissionMode?: 'default' \| 'bypassPermissions' \| string; allowDangerouslySkipPermissions?: boolean; allowedTools?: string[]; disallowedTools?: string[]; tools?: string[]; skills?: string[]; baseInstruct…` |

### `src/platform.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `isProcessAlive` | upstream | 2 | zalo/daemon.ts:54<br>zalo/supervisor.ts:33 | `export function isProcessAlive(pid: number): boolean` |
| `killProcess` | upstream | 1 | zalo/supervisor.ts:79 | `export function killProcess(pid: number, force = false): boolean` |

### `src/env-write.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `(vi.mock)` (type) (mocked) | n/a | 1 | fbstudio/core/routes.test.ts:35 | - |
| `setEnvKey` | upstream | 1 | zalo/dashboard-routes.ts:193 | `export function setEnvKey(envPath: string, key: string, value: string): void` |

### `src/agent-engine/index.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `EngineFactory` | upstream | 3 | zalo/variants.ts:158<br>fbstudio/analytics/agent-turn.ts:72 | `class EngineFactory { static forProvider(provider: ProviderConfig): AgentEngine }` |
| `(vi.mock)` (type) (mocked) | n/a | 2 | fbstudio/analytics/agent-turn.test.ts:4<br>fbstudio/comments/agent-turn-run.test.ts:12 | - |

### `src/outbound-policy.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `outboundOptionsForSeam` | upstream | 1 | fbstudio/comments/agent-turn.ts:256 | `export function outboundOptionsForSeam( seam: string, policy: OutboundPolicy = resolveOutboundPolicy(), ): SanitizeOptions ‖ export interface OutboundPolicy { enabled: boolean; protectedValues: string[]; }` |
| `resolveOutboundPolicy` | upstream | 1 | fbstudio/comments/agent-turn.ts:256 | `export function resolveOutboundPolicy( env: Record<string, string \| undefined> = process.env, ): OutboundPolicy` |

### `src/agent-engine/claude-sdk-adapter.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `*` | n/a | 1 | customer-care/application/agent-runner-engine.ts:98 | - |

### `src/agent-engine/openrouter-adapter.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `*` | n/a | 1 | customer-care/application/agent-runner-engine.ts:100 | - |

### `src/active-provider.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `defaultModelForProvider` | upstream | 4 | customer-care/runtime/app-deps.ts:80<br>zalo/variants.ts:159 | `export function defaultModelForProvider( provider: ProviderConfig, claudeDefault = DEFAULT_CLAUDE_MODEL, ): string \| undefined` |

### `src/env.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `readEnvFile` | upstream | 6 | customer-care/runtime/app-deps.ts:98<br>zalo/daemon.ts:76 | `export function readEnvFile(keys: string[]): Record<string, string>` |

### `src/provider-registry.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `providerRunnable` | upstream | 4 | customer-care/runtime/app-deps.ts:44<br>zalo/variants.ts:47 | `export function providerRunnable(type: ProviderType): boolean` |

### `src/security.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `getScrubbedSdkEnv` | upstream | 4 | customer-care/runtime/app-deps.ts:98<br>zalo/variants.ts:171 | `export function getScrubbedSdkEnv( authSecrets?: Partial<Record<typeof SDK_AUTH_VARS[number], string>>, ): Record<string, string \| undefined>` |

### `src/logger.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `logger` | upstream | 35 | zalo/birthday.ts:133<br>zalo/daemon.ts:55 | `const logger = pino(…)` |

### `src/crash-guard.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `(side-effect import)` | n/a | 1 | zalo/daemon.ts:13 | - |

### `src/outbound-sanitizer.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `sanitizeOutboundText` | upstream | 1 | fbstudio/comments/agent-turn.ts:257 | `export function sanitizeOutboundText(text: string, options: SanitizeOptions = {}): string ‖ export interface SanitizeOptions { enabled?: boolean; protectedValues?: string[]; seam?: string; onEvent?: (event: SanitizeDiagnostic) => void; }` |

## Web (web/src/)

| Module | Symbols | Kept files | Used by manifests |
|---|---:|---:|---|
| `web:lib/api.ts` | 10 | 72 | care, zalo, gmail, marketing, ads, core-web |
| `web:lib/format.ts` | 5 | 12 | care, core-web, zalo |
| `web:lib/chat-stream.ts` | 4 | 3 | core-web |
| `web:lib/useFetch.ts` | 3 | 58 | care, zalo, gmail, marketing, ads, core-web |
| `web:components/PageHeader.tsx` | 2 | 30 | care, zalo, gmail, marketing, ads, core-web |
| `web:components/Pill.tsx` | 2 | 26 | zalo, gmail, core-web, marketing |
| `web:lib/markdown.ts` | 2 | 5 | core-web |
| `web:lib/routes.ts` | 2 | 2 | core-web |
| `web:components/Modal.tsx` | 1 | 18 | care, zalo, gmail, marketing, core-web |
| `web:components/Toggle.tsx` | 1 | 19 | care, zalo, gmail, marketing, ads, core-web |
| `web:lib/toasts.ts` | 1 | 62 | care, zalo, gmail, marketing, ads, core-web |
| `web:components/ConfirmModal.tsx` | 1 | 15 | care, zalo, gmail, marketing, core-web |
| `web:components/PageState.tsx` | 1 | 37 | care, zalo, gmail, marketing, core-web |
| `web:lib/useDebounce.ts` | 1 | 9 | care, zalo, marketing, core-web |
| `web:lib/personalization.ts` | 1 | 1 | marketing |
| `web:components/AgentAvatar.tsx` | 1 | 6 | core-web |
| `web:lib/webgl.ts` | 1 | 1 | core-web |

### `web/src/lib/api.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `apiPost` | upstream | 49 | web:components/care-channels/ChannelCards.tsx:168<br>web:lib/care-channels/api.ts:34 | `export async function apiPost<T = unknown>(path: string, body?: unknown): Promise<T>` |
| `apiPatch` | upstream | 24 | web:components/care-channels/ChannelCards.tsx:158<br>web:lib/care/client.ts:90 | `export async function apiPatch<T = unknown>(path: string, body: unknown): Promise<T>` |
| `apiGet` | upstream | 21 | web:lib/care-channels/api.ts:29<br>web:lib/care-channels/badge.ts:20 | `export async function apiGet<T = unknown>(path: string): Promise<T>` |
| `apiPut` | upstream | 17 | web:lib/care-channels/api.ts:30<br>web:lib/care/client.ts:58 | `export async function apiPut<T = unknown>(path: string, body: unknown): Promise<T>` |
| `apiDelete` | upstream | 16 | web:lib/care/client.ts:64<br>web:components/marketing/GroupBroadcastDetail.tsx:54 | `export async function apiDelete<T = unknown>(path: string): Promise<T>` |
| `ApiError` | upstream | 10 | web:lib/care/client.ts:78<br>web:components/fb/library/AgentChatPanel.tsx:88 | `class ApiError { constructor(public status: number, public body: unknown, message: string) }` |
| `tokenizedSseUrl` | upstream | 6 | web:components/care/inbox/MediaImage.tsx:8<br>web:lib/care/useCareStream.ts:19 | `export function tokenizedSseUrl(path: string): string` |
| `apiFetch` | owner-unmarked | 4 | web:lib/care-channels/api.ts:37<br>web:lib/care/client.ts:25 | `export async function apiFetch(path: string, options: RequestInit): Promise<Response>` |
| `chatId` | upstream | 1 | web:components/ChatThread.tsx:55 | `const chatId = cachedChatId` |
| `dashboardToken` | upstream | 1 | web:lib/jarvis/session.tsx:456 | `const dashboardToken = cachedToken` |

### `web/src/lib/format.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `resolveAgentName` | upstream | 8 | web:components/care-channels/ChannelCards.tsx:57<br>web:components/care-channels/RulesSection.tsx:45 | `export function resolveAgentName(agentId: string): string` |
| `formatCost` | upstream | 2 | web:components/skills/SkillDeck.tsx:138<br>web:components/skills/SkillUsage.tsx:70 | `export function formatCost(usd: number): string` |
| `formatNumber` | upstream | 1 | web:components/skills/SkillUsage.tsx:69 | `export function formatNumber(n: number): string` |
| `formatRelativeTime` | upstream | 1 | web:pages/ZaloAccounts.tsx:190 | `export function formatRelativeTime(unixSeconds: number): string` |
| `seedAgentNames` | upstream | 1 | web:pages/MissionTaskDetail.tsx:27 | `export function seedAgentNames(agents: Array<{ id: string; name?: string }>): void` |

### `web/src/lib/chat-stream.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `subscribeChatStream` | upstream | 3 | web:components/ChatThread.tsx:146<br>web:lib/chat-conversations.ts:81 | `export function subscribeChatStream(fn: Listener): () => void ‖ type Listener = (eventName: string, data: any) => void;` |
| `chatStreamConnected` | upstream | 1 | web:components/ChatThread.tsx:73 | `const chatStreamConnected = signal(…)` |
| `isChatScopeProcessing` | owner-unmarked | 1 | web:components/ChatThread.tsx:64 | `export function isChatScopeProcessing(scope: string \| undefined): boolean` |
| `resetUnread` | upstream | 1 | web:components/ChatThread.tsx:145 | `export function resetUnread()` |

### `web/src/lib/useFetch.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `useFetch` | upstream | 57 | web:lib/care/zaloProfiles.ts:15<br>web:pages/care/CareChannels.tsx:46 | `export function useFetch<T = unknown>(path: string \| null, pollMs = 0): FetchState<T>` |
| `invalidateFetchCache` | upstream | 20 | web:components/marketing/GroupBroadcastDetail.tsx:57<br>web:components/marketing/ListBroadcastDetail.tsx:39 | `export function invalidateFetchCache(prefix?: string): void` |
| `FetchState` (type) | upstream | 1 | web:components/approvals-panels.tsx:37 | `export interface FetchState<T> { data: T \| null; loading: boolean; error: string \| null; refresh: () => void; }` |

### `web/src/components/PageHeader.tsx`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `PageHeader` | upstream | 27 | web:pages/care/CareActivity.tsx:54<br>web:pages/care/CareChannels.tsx:112 | `export function PageHeader({ title, breadcrumb, actions, tabs, compact }: PageHeaderProps) ‖ export interface PageHeaderProps { title: string; breadcrumb?: string; actions?: ComponentChildren; tabs?: ComponentChildren; compact?: boolean; }` |
| `Tab` | upstream | 5 | web:pages/care/CareDrafts.tsx:69<br>web:components/marketing/BirthdayHistory.tsx:32 | `export function Tab({ label, active, count, onClick }: TabProps) ‖ export interface TabProps { label: string; active?: boolean; count?: number; onClick?: () => void; }` |

### `web/src/components/Pill.tsx`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `Pill` | upstream | 22 | web:components/care-channels/zalo/ZaloNickModals.tsx:236<br>web:components/marketing/BirthdayHistory.tsx:66 | `export function Pill({ tone = 'neutral', children }: Props) ‖ interface Props { tone?: Tone; children: ComponentChildren; }` |
| `StatusDot` | upstream | 4 | web:components/fb/library/AgentChatPanel.tsx:186<br>web:components/AgentPicker.tsx:68 | `export function StatusDot({ tone }: { tone: Tone })` |

### `web/src/lib/markdown.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `renderMarkdown` | upstream | 4 | web:components/ChatActivity.tsx:93<br>web:components/memory/RecordDrawer.tsx:60 | `export function renderMarkdown(text: string): string` |
| `renderBrainMarkdown` | owner-unmarked | 1 | web:components/BrainNoteEditor.tsx:25 | `export function renderBrainMarkdown(text: string, source: string, ids: ReadonlySet<string>): string` |

### `web/src/lib/routes.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `ROUTES` | upstream | 2 | web:lib/jarvis/session.tsx:114<br>web:lib/page-context.ts:54 | `const ROUTES: RouteDef[]` |
| `SECTION_LABEL` | upstream | 1 | web:lib/page-context.ts:58 | `const SECTION_LABEL: Record<RouteSection, string>` |

### `web/src/components/Modal.tsx`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `Modal` | upstream | 18 | web:components/care-channels/AddChannelModal.tsx:9<br>web:components/care-channels/AdvancedPanel.tsx:98 | `export function Modal({ open, onClose, title, width = 480, height, bodyClassName, closeDisabled, dismissOnBackdrop = true, children, footer }: Props) ‖ interface Props { open: boolean; onClose: () => void; title: string; width?: number; height?: string; bodyClassName?: string; closeDisabled?: boolean; dismissOnBackdrop?: boolean; children: ComponentChildren; footer?: ComponentChildren; }` |

### `web/src/components/Toggle.tsx`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `Toggle` | upstream | 19 | web:components/care-channels/AdvancedPanel.tsx:74<br>web:components/care-channels/ChannelCards.tsx:113 | `export function Toggle({ on, onChange, disabled, size = 'md', ariaLabel }: ToggleProps) ‖ interface ToggleProps { on: boolean; onChange: () => void; disabled?: boolean; size?: 'sm' \| 'md'; ariaLabel?: string; }` |

### `web/src/lib/toasts.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `pushToast` | upstream | 62 | web:components/care-channels/AdvancedPanel.tsx:36<br>web:components/care-channels/CannedSection.tsx:28 | `export function pushToast(t: Omit<Toast, 'id'>): number` |

### `web/src/components/ConfirmModal.tsx`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `ConfirmModal` | upstream | 15 | web:components/care-channels/CannedSection.tsx:61<br>web:components/care-channels/RulesSection.tsx:192 | `export function ConfirmModal({ open, onClose, onConfirm, title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', destructive = false, loading = false, detail, }: Props) ‖ interface Props { open: boolean; onClose: () => void; onConfirm: () => void; title: string; body?: string; confirmLabel?: string; cancelLabel?: string; destructive?: boolean; loading?: boolean; detail?: string; }` |

### `web/src/components/PageState.tsx`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `PageState` | upstream | 37 | web:components/care-channels/CannedSection.tsx:41<br>web:components/care-channels/NotifySection.tsx:73 | `export function PageState({ loading, error, empty, emptyTitle, emptyDescription }: Props) ‖ interface Props { loading?: boolean; error?: string \| null; empty?: boolean; emptyTitle?: string; emptyDescription?: string; }` |

### `web/src/lib/useDebounce.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `useDebouncedValue` | upstream | 9 | web:components/care/customer/IdentityPanel.tsx:25<br>web:components/care/EffectiveRulePreview.tsx:13 | `export function useDebouncedValue<T>(value: T, delayMs: number): T` |

### `web/src/lib/personalization.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `modKeyLabel` | upstream | 1 | web:components/fb/library/AgentChatPanel.tsx:195 | `export function modKeyLabel(): string` |

### `web/src/components/AgentAvatar.tsx`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `AgentAvatar` | upstream | 6 | web:components/AgentPicker.tsx:63<br>web:components/ChatThread.tsx:340 | `export function AgentAvatar({ agentId, name, size = 36, running, cacheBust }: Props) ‖ interface Props { agentId: string; name?: string; size?: number; running?: boolean; cacheBust?: number \| string; }` |

### `web/src/lib/webgl.ts`

| Symbol | Origin | Kept files | Example call sites | TypeScript signature / props |
|---|---|---:|---|---|
| `hasWebGL` | upstream | 1 | web:components/memory/CortexStage.tsx:73 | `export function hasWebGL(): boolean` |

## CSS surface (web/src/styles/main.css)

Upstream main.css is also owner-modified (393 changed lines), so each item is tagged: `up` = also defined in upstream/main main.css, `owner` = added by the owner to main.css (extract it into AIOS-Lite main.css as is).

### Custom properties used via var(--x) (26)

| Property | Defined in main.css | Origin | Kept files | Example |
|---|---|---|---:|---|
| `--color-text-muted` | yes | up | 103 | web:components/care-channels/shared.tsx |
| `--color-text` | yes | up | 96 | web:components/care-channels/shared.tsx |
| `--color-border` | yes | up | 91 | web:components/care-channels/shared.tsx |
| `--color-accent` | yes | up | 76 | web:components/care-channels/shared.tsx |
| `--color-text-faint` | yes | up | 71 | web:components/care-channels/shared.tsx |
| `--color-card` | yes | up | 60 | web:styles/care-channels.css |
| `--color-elevated` | yes | up | 56 | web:styles/care-channels.css |
| `--color-status-failed` | yes | up | 47 | web:styles/care-channels.css |
| `--color-bg` | yes | up | 44 | web:components/care-channels/shared.tsx |
| `--color-control-hover` | yes | up | 38 | web:components/care-channels/shared.tsx |
| `--color-accent-soft` | yes | up | 36 | web:styles/care-channels.css |
| `--color-border-strong` | yes | up | 28 | web:styles/care-channels.css |
| `--color-status-done` | yes | up | 21 | web:styles/care-channels.css |
| `--color-accent-hover` | yes | up | 12 | web:styles/care-channels.css |
| `--color-sidebar` | yes | up | 10 | web:styles/care-channels.css |
| `--color-priority-medium` | yes | up | 10 | web:components/marketing/BirthdaySettings.tsx |
| `--color-status-running` | yes | up | 6 | web:styles/care-channels.css |
| `--color-priority-high` | yes | up | 6 | web:styles/care-channels.css |
| `--mem-` | no (defined elsewhere, e.g. runtime theme or component) | - | 2 | web:components/memory/CortexStage.tsx |
| `--av-hue` | no (defined elsewhere, e.g. runtime theme or component) | - | 1 | web:styles/care-inbox.css |
| `--chat-dock-width` | no (defined elsewhere, e.g. runtime theme or component) | - | 1 | web:components/fb/library/AgentChatPanel.tsx |
| `--color-danger` | no (defined elsewhere, e.g. runtime theme or component) | - | 1 | web:components/skills/SkillDeck.tsx |
| `--color-warning` | no (defined elsewhere, e.g. runtime theme or component) | - | 1 | web:components/skills/SkillDeck.tsx |
| `--sb-reader-w` | no (defined elsewhere, e.g. runtime theme or component) | - | 1 | web:styles/second-brain.css |
| `--section-color` | yes | owner | 1 | web:styles/sidebar-nav.css |
| `--color-control-text` | yes | up | 1 | web:styles/workspace.css |

### Global classes from main.css used in class strings (49)

| Class | Origin | Kept files | Example |
|---|---|---:|---|
| `.control-button` | up | 30 | web:components/care-channels/shared.tsx |
| `.control-accent` | up | 30 | web:components/care-channels/shared.tsx |
| `.toolbar-control` | up | 18 | web:components/care-channels/shared.tsx |
| `.is-on` | up | 15 | web:components/care-channels/AdvancedPanel.tsx |
| `.is-done` | owner | 4 | web:components/care/ConversationPane.tsx |
| `.is-active` | up | 3 | web:components/care/ConversationRow.tsx |
| `.is-open` | owner | 2 | web:components/ChatActivity.tsx |
| `.chat-message-content` | owner | 2 | web:components/ChatActivity.tsx |
| `.chat-md` | up | 2 | web:components/ChatActivity.tsx |
| `.chat-message` | owner | 2 | web:components/ChatActivity.tsx |
| `.chat-message-agent` | owner | 2 | web:components/ChatActivity.tsx |
| `.chat-message-flat` | owner | 2 | web:components/ChatActivity.tsx |
| `.chat-message-compact` | owner | 2 | web:components/ChatActivity.tsx |
| `.chat-message-body` | owner | 2 | web:components/ChatActivity.tsx |
| `.chat-reply` | owner | 2 | web:components/ChatActivity.tsx |
| `.chat-mention-tag` | owner | 2 | web:components/ChatThread.tsx |
| `.care-task` | owner | 1 | web:components/care/customer/CustomerTasks.tsx |
| `.care-timeline` | owner | 1 | web:components/care/Timeline.tsx |
| `.viewport-overlay` | up | 1 | web:components/fb/library/AgentChatPanel.tsx |
| `.app-dock` | owner | 1 | web:components/fb/library/AgentChatPanel.tsx |
| `.chat-input` | owner | 1 | web:components/fb/library/AgentChatPanel.tsx |
| `.chat-activity-tool` | owner | 1 | web:components/ChatActivity.tsx |
| `.chat-activity-faint` | owner | 1 | web:components/ChatActivity.tsx |
| `.chat-activity-steps` | owner | 1 | web:components/ChatActivity.tsx |
| `.chat-activity-step` | owner | 1 | web:components/ChatActivity.tsx |
| `.is-failed` | owner | 1 | web:components/ChatActivity.tsx |
| `.is-running` | owner | 1 | web:components/ChatActivity.tsx |
| `.chat-activity-step-icon` | owner | 1 | web:components/ChatActivity.tsx |
| `.chat-activity-step-label` | owner | 1 | web:components/ChatActivity.tsx |
| `.chat-activity` | owner | 1 | web:components/ChatActivity.tsx |
| `.chat-activity-head` | owner | 1 | web:components/ChatActivity.tsx |
| `.is-static` | owner | 1 | web:components/ChatActivity.tsx |
| `.chat-activity-chevron` | owner | 1 | web:components/ChatActivity.tsx |
| `.chat-reply-chunk` | owner | 1 | web:components/ChatActivity.tsx |
| `.chat-thinking-dots` | owner | 1 | web:components/ChatActivity.tsx |
| `.chat-thinking-label` | owner | 1 | web:components/ChatActivity.tsx |
| `.chat-activity-latest` | owner | 1 | web:components/ChatActivity.tsx |
| `.chat-activity-live` | owner | 1 | web:components/ChatActivity.tsx |
| `.chat-empty` | owner | 1 | web:components/ChatThread.tsx |
| `.chat-empty-compact` | owner | 1 | web:components/ChatThread.tsx |
| `.chat-empty-icon` | owner | 1 | web:components/ChatThread.tsx |
| `.chat-eyebrow` | owner | 1 | web:components/ChatThread.tsx |
| `.chat-starters` | owner | 1 | web:components/ChatThread.tsx |
| `.chat-message-user` | owner | 1 | web:components/ChatThread.tsx |
| `.chat-message-meta` | owner | 1 | web:components/ChatThread.tsx |
| `.chat-message-agent-avatar` | owner | 1 | web:components/ChatThread.tsx |
| `.chat-message-photo` | owner | 1 | web:components/ChatThread.tsx |
| `.chat-photo-caption` | owner | 1 | web:components/ChatThread.tsx |
| `.is-hidden` | owner | 1 | web:pages/SecondBrain.tsx |

### Tailwind theme tokens (@theme in main.css) used by utilities (5)

| Theme variable | Utilities seen | Kept files |
|---|---|---:|
| `--radius-md` | `rounded-md` | 43 |
| `--radius-lg` | `rounded-lg` | 53 |
| `--radius-xl` | `rounded-xl` | 11 |
| `--font-mono` | `font-mono` | 14 |
| `--radius-sm` | `rounded-t-sm` | 1 |

Theme variables defined in main.css @theme: --color-bg, --color-sidebar, --color-card, --color-elevated, --color-border, --color-border-strong, --color-text, --color-text-muted, --color-text-faint, --color-accent, --color-accent-hover, --color-accent-soft, --color-status-queued, --color-status-running, --color-status-done, --color-status-failed, --color-priority-high, --color-priority-medium, --color-priority-low, --font-sans, --font-mono, --radius-sm, --radius-md, --radius-lg, --radius-xl.

Note: class lists are detected from string literals in kept .tsx/.ts files and are an upper bound (a token that happens to equal a main.css class name counts). Dynamic class composition is not visible.

## Appendix: owner-core files imported by kept code (not upstream, not in any manifest)

These are owner-written, so they may be copied (class A/B) by the core agents, not rewritten. Listed because kept code cannot run without them.

| File | Modules | Kept files | Symbols |
|---|---|---:|---|
| `fbstudio/composio.ts` -> src/access/composio.ts | gmail, marketing, ads | 47 | ComposioAuthError, ComposioConnectionExpiredError, ComposioRateLimitError, (side-effect/mock), *, classifyComposioError, getComposio, hasComposioKey, listConnections, ComposioConnection, execute, graphAsPage, FbBudgetExceeded, FbCallTarget, ... |
| `agent-context.ts` | care, marketing | 3 | LEAN_CODEX_BASE_INSTRUCTIONS, (side-effect/mock) |
| `composio-credentials.ts` | gmail, marketing | 3 | (side-effect/mock), readComposioKey |
| `screen-context.ts` | care, marketing | 2 | parseScreenContext, buildScreenContextBlock |
| `budgets/engine-hook.ts` | care | 1 | beginBudgetTurn |
| `system-backup.ts` | care | 1 | applySystemRestore, createSystemBackup, restoreWorkDir, stageSystemRestore, validateSystemBackup, BackupPaths |
| `skill-commands.ts` | marketing | 1 | expandSkillCommand |
| `agent-skill-policy.ts` | marketing | 1 | SkillPermissionError |
| `vault-mentions.ts` | marketing | 1 | FolderMentionError, folderMentionContext |
| `brain-links.ts` | core-web | 1 | brainNoteUrl |
| `pnl/types.ts` | core-web | 1 | PnlDto, PnlKpis, PnlLine, PnlPreset, PnlProgram, PnlCampaign, PnlIssue, PnlSettings, ADS_OUT, ADS_SHARED, ADS_UNASSIGNED |
| `radar/types.ts` | core-web | 1 | IndexPayload, LayerConfig, LayerKey, RadarConfig |
