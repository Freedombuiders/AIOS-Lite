# Port manifest: ads (Meta Ads)

Generated from GỐC `claudeclaw-os` (working tree, upstream = `upstream/main`). Machine-readable: `ads.json`.

Scope: src/fbstudio/ads/** + FbAds page + components/fb/ads/** (+ duplicated chart/common components).

## Counts

| Item | Files | LOC |
|---|---:|---:|
| Kept (entries) | 37 | 8638 |
| - backend (modules/ads/server) | 25 | 5609 |
| - web | 12 | 3029 |
| - skills | 0 | 0 |
| Tests kept (*.test.ts[x]) | 10 | 2255 |
| Test-support/fixture files kept | 1 | 148 |
| Moved in from another module's source dir | 0 | 0 |
| Duplicated from marketing web (module isolation) | 2 | 756 |
| Dropped | 0 | 0 |
| - of which tests dropped | 0 | |

Classes: A=7, B=30, D=0. (C = upstream files to rewrite; see the table at the bottom and compat-symbols.md.)

Kind rules used: A = no import resolving to an upstream file, another module, or an owner-core file outside every manifest; B = otherwise (rewire needed); D = ZaloCRM-derived (zalo only). Imports to core-web files keep their `@/` path and do not count as cross-module.

## db.ts sections to extract (not files; extract-db-sections.mjs)

| Marker | db.ts line | region LOC |
|---|---:|---:|
| @fbstudio-schema:ads | 1086 |  |
| @fbstudio-migrations:ads | 1587 |  |
| @fbstudio-db:ads | 8560 | 314 |

**Extraction pitfall:** 3 db.ts exports sit inside a marker region of another module: getZaloCustomerCare (line 8834, inside @fbstudio-db:ads, belongs to zalo); saveZaloCustomerCare (line 8841, inside @fbstudio-db:ads, belongs to zalo); zaloThreadHasCustomer (line 8862, inside @fbstudio-db:ads, belongs to zalo). A marker-only extraction would hand these to the wrong module. Exclude them from the ads store.

## Drop list

Nothing dropped.

## Dependency conflicts

### Kept file imports a dropped file (0 dropped files, 0 import sites)

None.

### Kept tests that import a dropped file (0; kept so coverage of kept code is not lost, need edit)

None.

### Imports of another module's files (3 distinct target files)

- to **marketing** (3 files):
  - `fbstudio/notify.ts` <- fbstudio/ads/accounts.test.ts, fbstudio/ads/accounts.ts, fbstudio/ads/routes.test.ts, fbstudio/ads/snapshot.test.ts, fbstudio/ads/worker.test.ts
  - `fbstudio/types.ts` <- fbstudio/ads/accounts.ts, fbstudio/ads/breakdowns.ts, fbstudio/ads/campaigns.ts, fbstudio/ads/dashboard.ts, fbstudio/ads/metrics.ts, ...
  - `fbstudio/index.ts` <- fbstudio/ads/worker.test.ts, fbstudio/ads/worker.ts

### db.ts functions owned by another module (5)

- owned by **marketing**: getFbSetting(2), setFbSetting(1), upsertFbPageFromSync(1), upsertFbPostMetrics(1), upsertImportedFbPost(1)

These functions live in the other module's extracted store; the importing module needs a provides/contract call or its own copy.

### Imports of owner-core files outside every manifest (1)

Owner-written (not upstream) files that stay in AIOS-Lite core (BUILD-PLAN §0.2 lists them as class A/B core files) or were moved to core. Needed with the same API:

- `fbstudio/composio.ts` (moved to core src/access/composio.ts): (side-effect/mock), *, ComposioAuthError, ComposioConnectionExpiredError, getComposio, hasComposioKey, listConnections, ComposioConnection, graphProxy, FbCallTarget, ComposioRateLimitError, FbBudgetExceeded (11 files)

### Advisory: kept non-test files imported only by dropped files (0)

None.

## Upstream (class C) imports this module needs

7 upstream modules, 40 symbols. Format: symbol(number of kept files using it); a trailing dagger marks a symbol that does not exist in upstream/main (owner-added to an upstream file, extract it instead of rewriting). Signatures are in compat-symbols.md.

- `db.ts` (31): getFbAdAccount†(8), FbAdAccountRow†(8), listFbAdAccounts†(7), updateFbAdAccountSettings†(6), upsertFbAdAccount†(6), _initTestDatabase(5), listFbAdsDaily†(4), listFbAdsRecommendations†(4), updateFbAdsRecommendation†(3), upsertFbAdsDaily†(3), FbAdsDailyInput†(3), getFbSetting†(2), replaceFbAdsPlacements†(2), listFbAdsPlacements†(2), FbAdsDailyRow†(2), FbAdsPlacementRow†(2), FbAdsRecommendationRow†(2), getFbAdsRecommendation†(2), markFbAdAccountSynced†(2), setFbAdAccountStatus†(1), setFbSetting†(1), upsertFbPageFromSync†(1), upsertFbPostMetrics†(1), upsertImportedFbPost†(1), listFbAdsOrganicRows†(1), FbAdsOrganicRow†(1), insertFbAdsRecommendation†(1), recomputeFbAdsResults†(1), pruneFbAdsData†(1), setFbAdsWindowFrequency†(1), expireStaleFbAdsRecommendations†(1)
- `web:lib/api.ts` (3): apiPost(4), apiPatch(3), apiGet(1)
- `web:lib/useFetch.ts` (2): useFetch(5), invalidateFetchCache(4)
- `logger.ts` (1): logger(5)
- `web:lib/toasts.ts` (1): pushToast(4)
- `web:components/Toggle.tsx` (1): Toggle(4)
- `web:components/PageHeader.tsx` (1): PageHeader(1)
