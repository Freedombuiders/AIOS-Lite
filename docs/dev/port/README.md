# Porting manifests (P0.6)

Generated 2026-10-24 from GỐC (`claudeclaw-os` working tree; upstream = `upstream/main`). One JSON manifest per module (consumed by `scripts/port/copy.mjs`) plus a human summary.

| Module | Manifest | Summary |
|---|---|---|
| care | [care.json](care.json) | [care.md](care.md) |
| zalo | [zalo.json](zalo.json) | [zalo.md](zalo.md) |
| gmail | [gmail.json](gmail.json) | [gmail.md](gmail.md) |
| marketing | [marketing.json](marketing.json) | [marketing.md](marketing.md) |
| ads | [ads.json](ads.json) | [ads.md](ads.md) |
| core-web | [core-web.json](core-web.json) | [core-web.md](core-web.md) |
| compat | | [compat-symbols.md](compat-symbols.md) |

## Totals

| Module | Kept files | Kept LOC | Tests | Moved in | Dropped files | Dropped LOC | A | B | D | Kept->dropped import targets | Kept tests needing rewire | Cross-module targets |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| care | 312 | 57256 | 94 | 0 | 162 | 33586 | 251 | 61 | 0 | 33 | 15 | 29 |
| zalo | 94 | 22071 | 30 | 19 | 21 | 5071 | 26 | 55 | 13 | 5 | 1 | 14 |
| gmail | 34 | 8946 | 11 | 13 | 21 | 4472 | 7 | 27 | 0 | 5 | 5 | 13 |
| marketing | 101 | 20880 | 30 | 0 | 10 | 1480 | 32 | 69 | 0 | 3 | 0 | 4 |
| ads | 37 | 8638 | 10 | 0 | 0 | 0 | 7 | 30 | 0 | 0 | 0 | 3 |
| core-web | 139 | 27237 | 18 | 0 | 0 | 0 | 87 | 52 | 0 | 0 | 0 | 3 |
| **total** | 717 | 145028 | 193 | 32 | 214 | 44609 | 410 | 294 | 13 | | | |

Notes: "Kept files" includes 2 web files duplicated into ads (same source file appears in marketing/core and ads manifests), so the total double-counts them. Files and LOC include test and test-support files.

Compat surface: 36 upstream modules (19 backend, 17 web), 447 distinct symbols. See compat-symbols.md.

## Path mapping used by the manifests

- care: `src/customer-care/X` -> `modules/care/server/X`
- zalo: `src/zalo/X` -> `modules/zalo/server/X`; `src/customer-care/connectors/zalo/X` -> `modules/zalo/server/connectors/zalo/X`
- gmail: `src/email/X` -> `modules/gmail/server/X`; `src/customer-care/connectors/email/X` -> `modules/gmail/server/connectors/email/X`
- marketing: `src/fbstudio/X` -> `modules/marketing/server/X`; skills -> `modules/marketing/skills/<name>/...`
- ads: `src/fbstudio/ads/X` -> `modules/ads/server/X`
- web: `web/src/R` -> `modules/<id>/web/R` (module) or `web/src/R` (core-web). Imports use the `@/` alias = web/src; the copy script must rewrite `@/<module-owned path>` to the module location.
- Relative imports between files that moved to different roots (for example zalo connector -> src/zalo) need rewriting.

## Rules used

- Every file under each scope is in exactly one of `entries` / `drop` of one manifest (verified by the generator).
- No entry exists in `upstream/main` (verified with `git cat-file --batch-check`).
- BUILD-PLAN §5 drop lists applied literally; extensions are marked in the reason text and listed in each summary.
- A test is dropped only when all its in-scope imports are dropped; a test that also touches kept code stays and is flagged.
- Owner-only web files outside any module namespace go to the module that alone reaches them, or to core-web when reached by two or more.

## Decisions that need a human

1. **care-fence (zalo + gmail).** Both zalo/care-fence.ts and email/care-fence.ts import the dropped customer-care/runtime/legacy-compat.ts; they are a legacy-coexistence fence ("who owns the write"). Kept zalo files (birthday, daemon, dashboard-routes, group-broadcast, history, ingest, list-broadcast) and gmail sender/sync/routes still call them. Recommended: drop them and replace the calls (care always owns writes). Alternative: keep care-fence + a trimmed legacy-compat. The manifests drop them (zalo: §5, gmail: extension).
2. **zalo AI-path wiring.** zalo/daemon.ts imports daemon-care + responder, dashboard-routes.ts imports gate + routes-customer-care (§5 drops them), and customer-care/connectors/zalo/daemon-test-kit.ts imports daemon-care. Needs an edit of daemon.ts/dashboard-routes.ts, or reinstating daemon-care (the care control the daemon uses to feed the care connector).
3. **gmail kept-list gaps.** §5 keeps gmail/parse/sync/sender/serialize/dto/time but not email/routes.ts or test-fixtures.ts. Manifest keeps both (EmailAccounts page needs the routes). routes.ts imports the dropped gate, responder, worker, care-fence, and serialize.ts imports gate (EMAIL_SKIP_REASON_LABEL); sender/sync import notify (notifyEmailOwner -> ctx.attention.raise). 5 kept gmail tests are kept-and-flagged for the same reason.
4. **care wiring files.** 33 dropped files (telegram, bridge, cutover, legacy-delivery, owner-alerts) are still imported at 71 sites, almost all in api/index.ts, api/context.ts, runtime/care-runtime.ts, runtime/app-deps.ts, runtime/boot.ts, runtime/handlers.ts, runtime/care-guard.ts, application/ingest.ts, application/agent-turn.ts and web ChannelCards/AdvancedPanel/CareChannels/CareInbox. Also routes-drafts/routes-reply use legacy-delivery's parseLegacyIntentId and the care DTO/client still carry Bridge* types. Edits, not decisions, but the largest rewrite item. 15 kept care tests also need edits.
5. **care <-> zalo/gmail coupling.** care/runtime builds the Zalo and Email connectors directly (care->zalo and care->gmail edges in care.md) and care web (ChannelCards, RulesSection, lib/care-channels/*) imports lib/zalo, lib/email, components/email/InboxUtils, zalo/customer-care-types. BUILD-PLAN solves this with provides.careChannel / care.channelPanel; this is the main refactor to make zalo/gmail truly optional. Also lib/care/zaloEdit.ts and zaloProfiles.ts are zalo-specific but sit in lib/care (kept in care per plan).
6. **marketing <-> ads cycle.** marketing agent-view/index/routes import ads files, and ads imports marketing notify/types/index; db functions are shared both ways (getFbSetting, upsertFbPostMetrics, getFbAdAccount...). BUILD-PLAN says modules must not import each other. Needs a shared types/notify in core and ads registered through provides.
7. **Shared Composio client.** fbstudio/composio.ts is imported by marketing, ads AND gmail (gmail-transport, gmail.ts, routes.ts). Dropped from the marketing manifest as "moved to core" (P1-B access/composio.ts); every importer needs it with the same API (see compat appendix).
8. **Web files promoted to core-web (beyond the plan).** components/fb/charts/** and lib/marketing.ts are imported by core dashboard/pnl/RichTextEditor and by zalo/ads, so they are in core-web, not marketing; this also removes the chart duplicates the plan wanted in ads. components/social/PlatformBadge.tsx is reinstated into core-web (FbCalendar + HomeDashboard use it). Revert in build.mjs PROMOTE if you prefer plan literalism.
9. **Core pages that depend on modules.** HomeDashboard imports lib/fbstudio (marketing), lib/page-context imports lib/care/unify (care). Core must not import modules: turn these into module widgets / a screen-context provider. SocialOverview (marketing) imports SocialHome (dropped), FbLibrary imports WhopPostDialog/whop-social (dropped): strip the Whop/other-platform parts.
10. **core-web closure size.** Following imports from the listed core pages pulls in kol, jarvis, radar, pnl, whop-pulse, social-platforms, command-center helpers (via HomeDashboard, BusinessPulse). Prune the manifest if the core UI should not carry them. Web files also import 3 backend type files (brain-links, pnl/types, radar/types) that need a shared contract.
11. **db.ts extraction pitfall.** getZaloCustomerCare, saveZaloCustomerCare, zaloThreadHasCustomer (db.ts 8834-8873) sit inside the @fbstudio-db:ads region. Extract them into zalo, not ads. 55 imported owner-written functions are outside any marker (the original zalo_* functions and getCareDbHandle); extraction by markers alone would miss them.
12. **ZaloCRM NOTICE.** Only 12 of the 15 listed files remain in zalo (agent-turn, gate, responder are dropped); NOTICE should list 12 plus any other file that mentions ZaloCRM.
13. **main.css owner additions.** Kept web code uses owner-added classes in main.css (chat-message*, chat-activity*, chat-empty*, is-done, is-open, ...), see compat-symbols.md CSS section; they must be extracted into the new main.css, not rewritten from upstream.

