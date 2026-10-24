# Integrations (Pancake, Botcake, Composio…): port plan (P4)

Mang bộ khung integration của GỐC (`src/integrations/**`, `web/src/pages/Integrations.tsx`; tất cả là code của chủ, không có ở upstream) sang AIOS-Lite thành **tính năng của lõi**, nằm ở trang **Kết nối**.

## Đã chốt

- **Integration mang sang:** Pancake (POS + chat), Botcake, Composio + Google (qua Composio), Pexels, Freesound, ElevenLabs, FPT.AI.
- **Để sau** (thuộc module chưa port): Apify, RSSHub (Radar), fal, Higgsfield (KOL), HeyGen (Video). MCP Hubs của GỐC cũng để sau, vì `config/connections.yaml` đã lo phần MCP.
- **Quyền:** `agent.yaml` có `access.integrations: { pancake: read | ask | write | { grant, ask: [lệnh…], allow: [lệnh…] } }`. Không khai báo thì quyền là tắt. Kiểu dữ liệu nằm trong `src/core/types.ts` (`IntegrationGrant`, `IntegrationGrantSetting`).
  - Ma trận quyền giữ nguyên như GỐC: `read` chỉ chạy lệnh đọc; `ask` cho đọc chạy ngay, còn lệnh ghi phải chờ duyệt; `write` cho ghi; lệnh `destructive` luôn phải duyệt.
- **Agent gọi integration qua MCP, không qua shell:** server MCP dựng sẵn `aios-integrations` (stdio).
  - Mỗi lệnh được phép là một tool.
  - Server MCP gọi về `POST /api/integrations/call` kèm **token theo lượt chạy**, nên khoá không bao giờ tới tiến trình của agent.
  - Claude, Codex và Hermes chặn cứng MCP theo quyền; Grok chỉ chặn mềm. Lượt `lean` không có tool.
- **Duyệt lệnh:**
  - Lệnh ghi ở mức `ask` (và mọi lệnh destructive) tạo một dòng trong `integration_approvals` và một mục **Cần bạn** (`key: integration:approval:<id>`, `kind: 'module'`, `link: '/connections?tab=approvals'`).
  - Tool trả cho agent: *"Đã gửi chủ duyệt (mã …), lệnh CHƯA chạy."*
  - Khi chủ bấm **Duyệt**: chạy lệnh, lưu kết quả, rồi thêm bình luận vào việc với `requeue: true`. Agent được gọi lại với trigger `commented` và thấy kết quả.
  - **Từ chối**: thêm bình luận "chủ đã từ chối" (requeue).
  - **Luôn cho phép y hệt**: tạo một dòng trong `integration_trust_rules`.
- **Bảng:** migration lõi `002_integrations`, đã có (`integration_credentials`, `integration_calls`, `integration_approvals`, `integration_trust_rules`). Không tạo thêm bảng khác.

## Hợp đồng API (Hono, cùng định dạng lỗi trong `docs/dev/API.md`)

| Method | Path | Body | Trả về |
|---|---|---|---|
| GET | `/api/integrations` | — | `{ items: IntegrationSummary[] }` |
| PUT | `/api/integrations/:id` | `{ values: Record<string,string> }`; field secret để trống nghĩa là giữ giá trị cũ | `IntegrationSummary`. Chỉ lưu khi test đạt; không đạt thì trả 400 kèm `detail` |
| POST | `/api/integrations/:id/test` | — | `{ ok, detail, accountLabel? }` |
| DELETE | `/api/integrations/:id` | — | `{ ok: true }` |
| GET | `/api/agents/:id/integrations` | — | `{ grants: Record<string, IntegrationGrantSetting> }` |
| PUT | `/api/agents/:id/integrations` | `{ grants }` | như GET. Ghi vào `agent.yaml` (`access.integrations`) qua registry |
| GET | `/api/integrations/approvals` | `?status=pending` | `{ items: IntegrationApproval[] }` |
| POST | `/api/integrations/approvals/:id/approve` | `{ always?: boolean }` | `IntegrationApproval` (đã chạy, có `result`/`error`) |
| POST | `/api/integrations/approvals/:id/reject` | — | `IntegrationApproval` |
| GET | `/api/integrations/tools` | header `Authorization: Bearer <runToken>` | `{ tools: BridgeTool[] }`: các lệnh agent được phép |
| POST | `/api/integrations/call` | header `Authorization: Bearer <runToken>`; body `{ integration, command, args: string }` | `{ ok: true, result }`, hoặc `{ ok: false, code: 'denied'\|'not_configured'\|'approval_pending'\|'usage'\|'api'\|'rate_limited', message, approvalId? }` |

Các route OAuth của Composio/Google mang sang nguyên, dưới `/api/integrations/composio/...`.

Các kiểu dữ liệu:

```ts
type IntegrationSummary = {
  id, name, category, description, docsUrl?, authKind: 'api-key' | 'oauth', group?,
  setupSteps: string[],
  fields: { key, label, kind: 'secret' | 'text', required, placeholder?, help?, value: string /* secret: '••••abcd' hoặc '' */ }[],
  status: 'not_configured' | 'unchecked' | 'ok' | 'error', statusDetail, accountLabel, checkedAt: string | null,
  commands: { name, access: 'read' | 'write', risk: 'read' | 'write' | 'destructive', usage, description }[],
  grantedTo: { agentId, grant }[], calls24h: number,
};
type IntegrationApproval = {
  id, integrationId, agentId, taskId, command, args: string, risk, status,
  result?: unknown, error?, createdAt, decidedAt?,
};
type BridgeTool = {
  name: string /* `${integrationId}__${command với dấu cách và gạch ngang đổi thành _}` */,
  integrationId, command, description, usage, access, risk,
};
```

## Token theo lượt chạy (`src/integrations/run-token.ts`, do I1 viết)

- `createRunToken({ agentId, taskId }, secret, ttlMs = 2h): string`: HMAC-SHA256 của `agentId.taskId.exp`. `secret` là kv `integrations_token_secret`, sinh ngẫu nhiên lần đầu.
- `verifyRunToken(token, secret): { agentId, taskId } | null`.

## Phân việc

| Agent | Sở hữu | Việc |
|---|---|---|
| **I1 · backend** | `src/integrations/**` (trừ `mcp-bridge/`), `src/api/routes/integrations.ts`, mount route trong `src/api/server.ts`, field `integrations` trong `src/agents/schema.ts` và registry | Copy file của chủ (`node scripts/port/copy.mjs` với một manifest `docs/dev/port/integrations.json`); nối store vào `getDb()`/cipher của lõi; runner (kiểm quyền, giới hạn 600/giờ, nhật ký, duyệt, trust rule); approvals với attention và requeue bình luận; run token; route; test |
| **I2 · MCP bridge** | `src/integrations/mcp-bridge/**`, `src/access/policy.ts` (thêm grant cho bridge), `src/work/engine.ts` (tạo token), `src/shared/context.ts` (khối hướng dẫn integration) | Viết server MCP stdio tối giản (`initialize`, `tools/list`, `tools/call`); policy thêm `McpGrant { id: 'aios-integrations', command: process.execPath, args: [bridge], env: { AIOS_API_URL, AIOS_RUN_TOKEN }, allowedTools: ['*'] }` khi agent có ít nhất một quyền khác `off` và lượt không phải lean; context liệt kê `agentGuide` của các integration được cấp; test có server API giả |
| **I3 · web** | `web/src/pages/Connections.tsx` (gộp trang Integrations của chủ), `web/src/lib/integrations.ts`, `web/src/components/agents/AccessEditor.tsx` (chọn quyền integration), phần Cần bạn trên Tổng quan | Copy `Integrations.tsx` và `lib/integrations.ts` của chủ rồi nối với API mới. Trang Kết nối có 3 tab: **Integrations** (danh mục, form kết nối, kiểm tra, xoá, agent được cấp), **Chờ duyệt** (Duyệt / Duyệt luôn y hệt / Từ chối), **MCP & khoá** (`connections.yaml` hiện có). Tab Quyền của agent có bảng mức quyền theo từng integration. Mục Cần bạn có `integration:approval:*` thì có nút Duyệt/Từ chối ngay tại chỗ. Mock API có dữ liệu mẫu cho Pancake |

## Xong khi

- Typecheck sạch; toàn bộ vitest xanh; `check-provenance` 0 trùng; e2e 5/5.
- Test với `fetch` giả: Pancake `orders list` chạy khi quyền là `read`; `orders create` ở mức `read` bị từ chối; ở mức `ask` thì tạo approval, duyệt xong thì lệnh chạy và việc được requeue; `set-status` sang huỷ dưới quyền `write` vẫn phải duyệt.
- Bridge: `tools/list` chỉ có tool được phép; gọi qua token sai thì trả 401.
- Kiểm thật (chỉ đọc): chỉ khi chủ đã nhập key Pancake. Chưa có key thì bỏ qua và ghi lại là đã bỏ qua.
