# Port manifest: core-web (shared and core UI)

Generated from GỐC `claudeclaw-os` (working tree, upstream = `upstream/main`). Machine-readable: `core-web.json`.

Scope: owner-only shared web files + core pages (HomeDashboard, Memory, SkillStudio, ...) with their owner-only closure.

## Counts

| Item | Files | LOC |
|---|---:|---:|
| Kept (entries) | 139 | 27237 |
| - backend (modules/core-web/server) | 0 | 0 |
| - web | 139 | 27237 |
| - skills | 0 | 0 |
| Tests kept (*.test.ts[x]) | 18 | 2420 |
| Test-support/fixture files kept | 0 | 0 |
| Moved in from another module's source dir | 0 | 0 |
| Dropped | 0 | 0 |
| - of which tests dropped | 0 | |

Classes: A=87, B=52, D=0. (C = upstream files to rewrite; see the table at the bottom and compat-symbols.md.)

Kind rules used: A = no import resolving to an upstream file, another module, or an owner-core file outside every manifest; B = otherwise (rewire needed); D = ZaloCRM-derived (zalo only). Imports to other core-web files do not count; `@/` paths stay the same.

## Drop list

Nothing dropped.

## Reinstated / promoted (decisions beyond the literal plan)

- `web:components/fb/charts/chart-utils.ts`: promoted from marketing to core-web (beyond BUILD-PLAN): imported by core dashboard/pnl/RichTextEditor and by zalo/ads, so a module must not own it
- `web:components/fb/charts/DailyBars.tsx`: promoted from marketing to core-web (beyond BUILD-PLAN): imported by core dashboard/pnl/RichTextEditor and by zalo/ads, so a module must not own it
- `web:components/fb/charts/DashStates.tsx`: promoted from marketing to core-web (beyond BUILD-PLAN): imported by core dashboard/pnl/RichTextEditor and by zalo/ads, so a module must not own it
- `web:components/fb/charts/FollowBars.tsx`: promoted from marketing to core-web (beyond BUILD-PLAN): imported by core dashboard/pnl/RichTextEditor and by zalo/ads, so a module must not own it
- `web:components/fb/charts/Funnel.tsx`: promoted from marketing to core-web (beyond BUILD-PLAN): imported by core dashboard/pnl/RichTextEditor and by zalo/ads, so a module must not own it
- `web:components/fb/charts/Legend.tsx`: promoted from marketing to core-web (beyond BUILD-PLAN): imported by core dashboard/pnl/RichTextEditor and by zalo/ads, so a module must not own it
- `web:components/fb/charts/LineChart.tsx`: promoted from marketing to core-web (beyond BUILD-PLAN): imported by core dashboard/pnl/RichTextEditor and by zalo/ads, so a module must not own it
- `web:components/fb/charts/Quadrant.tsx`: promoted from marketing to core-web (beyond BUILD-PLAN): imported by core dashboard/pnl/RichTextEditor and by zalo/ads, so a module must not own it
- `web:components/fb/charts/RowBars.tsx`: promoted from marketing to core-web (beyond BUILD-PLAN): imported by core dashboard/pnl/RichTextEditor and by zalo/ads, so a module must not own it
- `web:components/fb/charts/Sparkline.tsx`: promoted from marketing to core-web (beyond BUILD-PLAN): imported by core dashboard/pnl/RichTextEditor and by zalo/ads, so a module must not own it
- `web:components/fb/charts/StackedBars.tsx`: promoted from marketing to core-web (beyond BUILD-PLAN): imported by core dashboard/pnl/RichTextEditor and by zalo/ads, so a module must not own it
- `web:components/fb/charts/useElementWidth.ts`: promoted from marketing to core-web (beyond BUILD-PLAN): imported by core dashboard/pnl/RichTextEditor and by zalo/ads, so a module must not own it
- `web:components/social/PlatformBadge.tsx`: reinstated into core-web: imported by kept marketing FbCalendar/PostSheet and by core HomeDashboard/BusinessPulse
- `web:lib/marketing.ts`: promoted from marketing to core-web (beyond BUILD-PLAN): imported by core dashboard/pnl/RichTextEditor and by zalo/ads, so a module must not own it

## Dependency conflicts

### Kept file imports a dropped file (0 dropped files, 0 import sites)

None.

### Kept tests that import a dropped file (0; kept so coverage of kept code is not lost, need edit)

None.

### Imports of another module's files (3 distinct target files)

- to **marketing** (2 files):
  - `web:components/fb/common.tsx` <- web:components/fb/charts/DashStates.tsx
  - `web:lib/fbstudio.ts` <- web:components/fb/charts/DashStates.tsx, web:pages/HomeDashboard.tsx
- to **care** (1 files):
  - `web:lib/care/unify.ts` <- web:lib/page-context.ts

### db.ts functions owned by another module (0)

None.

### Imports of owner-core files outside every manifest (3)

Owner-written (not upstream) files that stay in AIOS-Lite core (BUILD-PLAN §0.2 lists them as class A/B core files) or were moved to core. Needed with the same API:

- `brain-links.ts`: brainNoteUrl (1 files)
- `pnl/types.ts`: PnlDto, PnlKpis, PnlLine, PnlPreset, PnlProgram, PnlCampaign, PnlIssue, PnlSettings, ADS_OUT, ADS_SHARED, ADS_UNASSIGNED (1 files)
- `radar/types.ts`: IndexPayload, LayerConfig, LayerKey, RadarConfig (1 files)

### Advisory: kept non-test files imported only by dropped files (0)

None.

### Files assigned to this module by import reach (not under a module namespace): 72

web:components/AgentPicker.tsx, web:components/approvals-agent-grants.tsx, web:components/approvals-command-list.tsx, web:components/approvals-grant-selector.tsx, web:components/approvals-panels.tsx, web:components/BrainLocalGraph.tsx, web:components/BrainNoteEditor.tsx, web:components/BrainVaultGraph.tsx, web:components/budget-chart.tsx, web:components/budget-form.tsx, web:components/ChatActivity.tsx, web:components/dashboard/BusinessPulse.tsx, web:components/dashboard/charts.tsx, web:components/dashboard/PnlSection.tsx, web:components/dashboard/WhopPulse.tsx, web:components/McpHubAccess.tsx, web:components/McpHubs.tsx, web:components/memory/cortex-renderer.ts, web:components/memory/CortexStage.tsx, web:components/memory/force-client.ts, web:components/memory/HeardFeed.tsx, web:components/memory/hooks.ts, web:components/memory/ImportDialog.tsx, web:components/memory/MemorySearch.tsx, web:components/memory/RecordDrawer.tsx, web:components/memory/SourceMark.tsx, web:components/memory/SourcesPanel.tsx, web:components/memory/sphere-scene.ts, web:components/memory/VisualCortex.tsx, web:components/mission-detail-properties.tsx, web:components/mission-detail-shared.tsx, web:components/mission-detail-subtasks.tsx, web:components/mission-detail-thread.tsx, web:components/org-card.tsx, web:components/org-viewport.tsx, web:components/pnl/PnlParts.tsx, web:components/QuickAssignTask.tsx, web:components/RunLivenessBadge.tsx, web:components/SkillPicker.tsx, web:components/skills/SkillDeck.tsx, web:components/skills/SkillFeedback.tsx, web:components/skills/SkillUsage.tsx, web:lib/approvals-grants.ts, web:lib/approvals-view.ts, web:lib/budget-view.ts, web:lib/business-pulse.ts, web:lib/chat-activity.ts, web:lib/chat-conversations.ts, web:lib/chat-v2.ts, web:lib/command-center.ts, web:lib/dashboard-kpis.ts, web:lib/home-dashboard.ts, web:lib/integrations.ts, web:lib/jarvis/audio.ts, web:lib/jarvis/helpers.ts, web:lib/jarvis/live.ts, web:lib/jarvis/protocol.ts, web:lib/jarvis/session.tsx, web:lib/kol-view.ts, web:lib/kol.ts, web:lib/mcpHubs.ts, web:lib/memory-force.ts, web:lib/memory-geometry.ts, web:lib/memory.ts, web:lib/mission-detail.ts, web:lib/org-layout.ts, web:lib/org-view.ts, web:lib/pnl.ts, web:lib/radar.ts, web:lib/run-liveness.ts, web:lib/whop-pulse.ts, web:pages/command-center/format.ts

## Upstream (class C) imports this module needs

16 upstream modules, 37 symbols. Format: symbol(number of kept files using it); a trailing dagger marks a symbol that does not exist in upstream/main (owner-added to an upstream file, extract it instead of rewriting). Signatures are in compat-symbols.md.

- `web:lib/api.ts` (10): apiPost(21), apiGet(13), apiPut(8), ApiError(7), apiDelete(7), apiPatch(7), tokenizedSseUrl(3), apiFetch†(2), chatId(1), dashboardToken(1)
- `web:lib/format.ts` (4): resolveAgentName(6), formatCost(2), formatNumber(1), seedAgentNames(1)
- `web:lib/chat-stream.ts` (4): subscribeChatStream(3), chatStreamConnected(1), isChatScopeProcessing†(1), resetUnread(1)
- `web:lib/useFetch.ts` (3): useFetch(24), invalidateFetchCache(6), FetchState(1)
- `web:components/Pill.tsx` (2): Pill(11), StatusDot(3)
- `web:lib/markdown.ts` (2): renderMarkdown(4), renderBrainMarkdown†(1)
- `web:lib/routes.ts` (2): ROUTES(2), SECTION_LABEL(1)
- `web:components/PageHeader.tsx` (2): PageHeader(7), Tab(1)
- `web:components/AgentAvatar.tsx` (1): AgentAvatar(6)
- `web:lib/toasts.ts` (1): pushToast(19)
- `web:components/PageState.tsx` (1): PageState(10)
- `web:components/ConfirmModal.tsx` (1): ConfirmModal(2)
- `web:components/Modal.tsx` (1): Modal(8)
- `web:lib/webgl.ts` (1): hasWebGL(1)
- `web:lib/useDebounce.ts` (1): useDebouncedValue(1)
- `web:components/Toggle.tsx` (1): Toggle(3)
