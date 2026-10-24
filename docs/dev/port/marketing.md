# Port manifest: marketing (Facebook Content Studio)

Generated from GỐC `claudeclaw-os` (working tree, upstream = `upstream/main`). Machine-readable: `marketing.json`.

Scope: src/fbstudio/** except ads/ + src/fbstudio-cli*.ts + web fb/social files + skills fb-content, fb-comment-reply.

## Counts

| Item | Files | LOC |
|---|---:|---:|
| Kept (entries) | 101 | 20880 |
| - backend (modules/marketing/server) | 76 | 15203 |
| - web | 23 | 5560 |
| - skills | 2 | 117 |
| Tests kept (*.test.ts[x]) | 30 | 6891 |
| Test-support/fixture files kept | 2 | 108 |
| Moved in from another module's source dir | 0 | 0 |
| Dropped | 10 | 1480 |
| - of which tests dropped | 1 | |

Classes: A=32, B=69, D=0. (C = upstream files to rewrite; see the table at the bottom and compat-symbols.md.)

Kind rules used: A = no import resolving to an upstream file, another module, or an owner-core file outside every manifest; B = otherwise (rewire needed); D = ZaloCRM-derived (zalo only). Imports to core-web files keep their `@/` path and do not count as cross-module.

## db.ts sections to extract (not files; extract-db-sections.mjs)

| Marker | db.ts line | region LOC |
|---|---:|---:|
| @fbstudio-schema:core | 871 |  |
| @fbstudio-schema:comments | 965 |  |
| @fbstudio-schema:analytics | 1033 |  |
| @fbstudio-migrations:core | 1579 |  |
| @fbstudio-migrations:comments | 1580 |  |
| @fbstudio-migrations:analytics | 1586 |  |
| @fbstudio-db:shared | 7591 | 32 |
| @fbstudio-db:core | 7623 | 321 |
| @fbstudio-db:comments | 7944 | 349 |
| @fbstudio-db:analytics | 8293 | 267 |

## Drop list

- **BUILD-PLAN §5: whop-social / other platforms in SocialHome+ChannelStrip (later)** (7 files)
  web:components/social/ChannelDetail.tsx, web:components/social/ChannelStrip.tsx, web:components/social/WhopCard.tsx, web:components/social/WhopPostDialog.tsx, web:components/social/YoutubeChannel.tsx, web:lib/whop-social.ts, web:pages/SocialHome.tsx
- **BUILD-PLAN §5: fbstudio-cli (to become 'aios module marketing ...' if time permits)** (2 files)
  fbstudio-cli.test.ts, fbstudio-cli.ts
- **moved to CORE: becomes shared Composio client src/access/composio.ts (BUILD-PLAN P1-B: composio-credentials + fbstudio/composio, class B). Used by marketing, ads and gmail** (1 files)
  fbstudio/composio.ts

## Dependency conflicts

### Kept file imports a dropped file (3 dropped files, 3 import sites)

Each is a wiring/call-site edit in the kept file (or a decision to keep the dropped file). Importer `file:line {symbols}`:

- `web:components/social/WhopPostDialog.tsx` <- web:pages/fb/FbLibrary.tsx:12 {WhopPostDialog}
- `web:lib/whop-social.ts` <- web:pages/fb/FbLibrary.tsx:13 {WHOP_SOCIAL_URL, WhopDraft, WhopSocialDto}
- `web:pages/SocialHome.tsx` <- web:pages/SocialOverview.tsx:7 {SocialHome}

### Kept tests that import a dropped file (0; kept so coverage of kept code is not lost, need edit)

None.

### Imports of another module's files (4 distinct target files)

- to **ads** (4 files):
  - `fbstudio/ads/accounts.ts` <- fbstudio/agent-view.ts
  - `fbstudio/ads/dashboard.ts` <- fbstudio/agent-view.ts
  - `fbstudio/ads/worker.ts` <- fbstudio/index.ts
  - `fbstudio/ads/routes.ts` <- fbstudio/routes.ts

### db.ts functions owned by another module (3)

- owned by **ads**: getFbAdAccount(1), listFbAdAccounts(1), FbAdAccountRow(1)

These functions live in the other module's extracted store; the importing module needs a provides/contract call or its own copy.

### Imports of owner-core files outside every manifest (7)

Owner-written (not upstream) files that stay in AIOS-Lite core (BUILD-PLAN §0.2 lists them as class A/B core files) or were moved to core. Needed with the same API:

- `fbstudio/composio.ts` (moved to core src/access/composio.ts): (side-effect/mock), *, execute, ComposioConnectionExpiredError, ComposioRateLimitError, graphAsPage, ComposioAuthError, FbBudgetExceeded, FbCallTarget, hasComposioKey, FB_MEDIA_DIR, listConnections, ComposioConnection (26 files)
- `screen-context.ts`: buildScreenContextBlock, parseScreenContext (1 files)
- `agent-context.ts`: (side-effect/mock), LEAN_CODEX_BASE_INSTRUCTIONS (2 files)
- `skill-commands.ts`: expandSkillCommand (1 files)
- `agent-skill-policy.ts`: SkillPermissionError (1 files)
- `vault-mentions.ts`: FolderMentionError, folderMentionContext (1 files)
- `composio-credentials.ts`: readComposioKey (1 files)

### Advisory: kept non-test files imported only by dropped files (0)

None.

## Upstream (class C) imports this module needs

25 upstream modules, 140 symbols. Format: symbol(number of kept files using it); a trailing dagger marks a symbol that does not exist in upstream/main (owner-added to an upstream file, extract it instead of rewriting). Signatures are in compat-symbols.md.

- `db.ts` (96): _initTestDatabase(14), getFbSetting†(9), getFbPage†(9), getFbCommentPage†(8), updateFbPageFields†(8), getFbContent†(8), getFbComment†(7), upsertFbPostMetrics†(6), getFbAnalyticsPage†(6), listFbAnalyticsPosts†(6), setFbSetting†(6), FbCommentPageRow†(6), listFbPostMetrics†(5), updateFbContentFields†(5), FbPageRow†(5), insertFbInsight†(4), upsertFbPageDaily†(4), getLatestFbInsight†(4), FbAnalyticsPageRow†(4), listFbPageDaily†(4), updateFbComment†(4), FbCommentRow†(4), upsertFbPageFromSync†(4), listFbPages†(4), FbContentRow†(4), getFbAnalyticsPostByFbId†(3), upsertImportedFbPost†(3), listFbPostMetricsForPost†(3), setFbCommentPageStatus†(3), listFbCommentsForLog†(3), upsertFbCommentWatch†(3), insertFbReplyTemplate†(3), listFbReplyTemplates†(3), insertFbContent†(3), saveTokenUsage(2), listFbUnclassifiedImportedPosts†(2), setFbImportedClassification†(2), countFbCommentsAnswered†(2), countFbPostCommentsAnswered†(2), getLastFbSnapshotAt†(2), listFbAnalyticsPages†(2), setFbAnalyticsPageFollowers†(2), setFbAnalyticsPageStatus†(2), FbPostMetricsRow†(2), FbAnalyticsPostRow†(2), getFbCommentForLog†(2), FbCommentLogRow†(2), putFbReplyRule†(2), getFbCommentWatch†(2), insertFbCommentIfNew†(2), listFbPublishLog†(2), setFbPageStatus†(2), claimFbContent†(2), getFbAdAccount†(1), listFbAdAccounts†(1), FbAdAccountRow†(1), FbPageDailyRow†(1), deleteFbReplyRule†(1), getFbReplyRuleJson†(1), listFbCommentsSince†(1), topFbCommentTopics†(1), fbCommentExists†(1), isFbOwnReplyId†(1), bumpFbReplyTemplateUses†(1), countFbRepliesDecidedSince†(1), countFbRepliesToAuthorOnPost†(1), getFbPostText†(1), hasFbReplyToAuthorSince†(1), listFbNewComments†(1), listFbThreadComments†(1), FbReplyTemplateRow†(1), deleteFbReplyTemplate†(1), getFbReplyTemplate†(1), listFbPostOverridePostIds†(1), listFbRecentPostsForRules†(1), updateFbReplyTemplate†(1), claimFbCommentForSend†(1), listFbDueComments†(1), listFbCommentPages†(1), getLatestFbChannelInsight†(1), listFbPostsWithMetrics†(1), countFbContentByStatus†(1), deleteFbContentRow†(1), listFbCalendarRows†(1), listFbContentRows†(1), listFbOccupiedTimes†(1), countFbSentReplies†(1), getFbLatestPostMetrics†(1), getFbPageWeekCounts†(1), expireFbPagesForConnection†(1), insertFbPublishLog†(1), listDueFbContent†(1), listStuckFbPublishing†(1), releaseFbContentClaim†(1), countFbApiCallsSince†(1), getNextScheduledFbContent†(1)
- `kill-switches.ts` (5): isEnabled(6), (vi.mock)(6), _reset(2), requireEnabled(2), KillSwitchDisabledError(1)
- `agent-config.ts` (5): (vi.mock)(3), listAgentIds(3), loadAgentConfig(2), resolveAgentDir(2), resolveAgentClaudeMd(1)
- `web:lib/api.ts` (5): apiPost(8), apiPatch(6), apiDelete(3), ApiError(2), apiPut(2)
- `provider.ts` (3): DEFAULT_PROVIDER(2), getMainProviderConfig(2), ProviderConfig(2)
- `config.ts` (3): CLAUDECLAW_CONFIG(1), PROJECT_ROOT(1), AGENT_ID(1)
- `agent-engine/index.ts` (2): (vi.mock)(2), EngineFactory(2)
- `outbound-policy.ts` (2): outboundOptionsForSeam(1), resolveOutboundPolicy(1)
- `web:lib/useFetch.ts` (2): useFetch(12), invalidateFetchCache(6)
- `web:components/PageHeader.tsx` (2): PageHeader(7), Tab(1)
- `active-provider.ts` (1): defaultModelForProvider(2)
- `env.ts` (1): readEnvFile(2)
- `provider-registry.ts` (1): providerRunnable(2)
- `security.ts` (1): getScrubbedSdkEnv(2)
- `logger.ts` (1): logger(13)
- `outbound-sanitizer.ts` (1): sanitizeOutboundText(1)
- `env-write.ts` (1): (vi.mock)(1)
- `web:lib/toasts.ts` (1): pushToast(9)
- `web:components/Modal.tsx` (1): Modal(2)
- `web:components/Pill.tsx` (1): StatusDot(1)
- `web:lib/personalization.ts` (1): modKeyLabel(1)
- `web:components/ConfirmModal.tsx` (1): ConfirmModal(2)
- `web:components/Toggle.tsx` (1): Toggle(3)
- `web:components/PageState.tsx` (1): PageState(4)
- `web:lib/useDebounce.ts` (1): useDebouncedValue(2)
