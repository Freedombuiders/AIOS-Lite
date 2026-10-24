# Bài 7. Viết module từ `_template`

Sau bài này bạn có thể:

- Tạo khung module bằng một lệnh và hiểu từng file trong đó.
- Khai báo `module.json`: bảng, scope, cài đặt, điều kiện; viết migration đúng luật.
- Dùng các móc của Module SDK: `routes`, `start/stop`, `onTaskFinished`, `contextFor`, `actions`, `agentContext`, `provides`.
- Viết phần web (`web/index.tsx`), chạy test của module, rồi Add, Remove, Purge.

Bài này đi qua việc làm một module tên **`bao-cao-tuan`** ("Báo cáo tuần") từ đầu đến cuối. Toàn bộ mã dưới đây đã được dựng thật trên một bản sao của repo: 5 test của module vượt qua, `npm run typecheck` (cả server lẫn web) không lỗi, và module đã Add, chạy, Remove, Purge thành công trên một API đang chạy. Bản sao đó đã được xoá, nên bạn gõ lại theo bài.

## 7.1 Module là gì (nhắc lại)

Module là một thư mục `modules/<id>/` mang một nghiệp vụ. Nó chỉ được dùng **Module SDK** (`src/modules/sdk.ts`) và không import phần bên trong của lõi.

```
modules/<id>/
├── module.json              khai báo: id, tên, scope, bảng, cài đặt, điều kiện
├── migrations/001_init.sql  tạo bảng (chỉ bảng đã khai báo)
├── server/index.ts          export default defineModule({...})
├── web/index.tsx            export default defineWebModule({...})
├── agents/<tên>/            agent mẫu (agent.yaml + persona.md)
├── skills/<tên>/SKILL.md    skill mang theo
└── README.md
```

Thư mục `modules/_template/` là khuôn mẫu. Bộ nạp bỏ qua mọi thư mục bắt đầu bằng `_` (`src/modules/loader.ts:89`), nên `_template` không hiện trong danh sách module. `modules/_lib/` (mã dùng chung như `care-kit`, `composio.ts`) cũng không phải module.

## 7.2 Bước 1. Tạo khung

```bash
npm run aios -- module new bao-cao-tuan
```

Lệnh này **không cần API đang chạy** (`src/cli/aios.ts`, `src/cli/scaffold.ts:9`). Nó chép `modules/_template/` sang `modules/bao-cao-tuan/` và thay chuỗi:

| Trong khuôn | Thành |
|---|---|
| `_template` (id, đường dẫn `/m/_template`, khoá module trong `agent.yaml`) | `bao-cao-tuan` |
| tiền tố bảng `template_` | `bao_cao_tuan_` (gạch ngang thành gạch dưới) |
| `template-helper`, `template-skill` | `bao-cao-tuan-helper`, `bao-cao-tuan-skill` |

Id module phải khớp `/^[a-z][a-z0-9-]{1,30}$/`, chưa tồn tại. Đã thử: `module new Bad_ID` báo `Id module "Bad_ID" không hợp lệ: dùng chữ thường, số, dấu gạch ngang; bắt đầu bằng chữ; 2–31 ký tự.` và chạy lại cho id đã có báo `Module "bao-cao-tuan" đã tồn tại tại ...`.

Kết quả là 8 file:

```
modules/bao-cao-tuan/README.md
modules/bao-cao-tuan/module.json
modules/bao-cao-tuan/migrations/001_init.sql
modules/bao-cao-tuan/server/index.ts
modules/bao-cao-tuan/web/index.tsx
modules/bao-cao-tuan/agents/bao-cao-tuan-helper/{agent.yaml,persona.md}
modules/bao-cao-tuan/skills/bao-cao-tuan-skill/SKILL.md
```

Khung là một module "Ghi chú mẫu" chạy được ngay (đã thử: `module add` ngay sau `module new` thì `GET /api/m/<id>/hello` trả lời được). Từ đây ta sửa dần thành "Báo cáo tuần". Lưu ý: khung còn giữ scope `notes.read` và `notes.write` của mẫu; ta sẽ thay.

## 7.3 Bước 2. `module.json`: khai báo

Schema kiểm tra ở `src/modules/loader.ts:18` (zod). Nội dung của ta:

```json
{
  "id": "bao-cao-tuan",
  "name": "Báo cáo tuần",
  "description": "Mỗi tuần một agent viết báo cáo từ Second Brain và bảng hoạt động đội, rồi lưu vào bảng riêng của module.",
  "version": "0.1.0",
  "icon": "notebook-pen",
  "category": "ops",
  "scopes": {
    "report.read": "Xem các báo cáo tuần đã lưu",
    "report.write": "Tạo và lưu báo cáo tuần"
  },
  "tables": ["bao_cao_tuan_reports"],
  "agentTemplates": ["bao-cao-tuan-helper"],
  "skills": ["bao-cao-tuan-skill"],
  "settings": {
    "autoWeekly": { "label": "Tự tạo báo cáo mỗi thứ Hai 8:00", "type": "boolean", "default": false },
    "reporterId": { "label": "Agent viết báo cáo", "type": "string", "default": "bao-cao-tuan-helper" }
  }
}
```

| Trường | Ý nghĩa và luật |
|---|---|
| `id` | Phải trùng tên thư mục |
| `name`, `description` | Hiện ở trang Module |
| `version` | Ghi vào bảng `modules` khi Add |
| `category` | Nhóm menu: `sales`, `marketing`, `ops`, `other` |
| `scopes` | `scope → nhãn tiếng Việt`. Bạn cấp scope cho agent ở `access.modules.<id>` (bài 3) |
| `tables` | **Mọi** bảng module tạo. Purge xoá đúng các bảng này |
| `agentTemplates`, `skills` | Tên thư mục agent mẫu và skill đi kèm |
| `settings` | Cài đặt khai báo: `boolean`, `number`, `string`, `select`, `secret` |
| `requires` | `{ modules: [...], connections: [...] }`: Add bị từ chối (mã 412) nếu thiếu. Ví dụ `gmail` cần module `care` và khoá `composio` |
| `enhances` | Module mà nó cắm thêm vào khi có (thông tin) |
| `license` | SPDX nếu khác giấy phép lõi (module `zalo` ghi `AGPL-3.0-only`) |

Kiểu `secret` được **mã hoá khi lưu** (bằng `AIOS_ENCRYPTION_KEY`) và bị che (`********`) khi đọc qua API (`src/modules/settings.ts`).

## 7.4 Bước 3. Migration và bảng

```sql
-- Chỉ được tạo các bảng đã khai báo trong module.json ("tables").
CREATE TABLE IF NOT EXISTS bao_cao_tuan_reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  summary    TEXT,
  task_id    INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

Luật của migration (`src/modules/manager.ts:107`, hàm `readMigrations`):

1. File `.sql` chạy theo thứ tự tên, mỗi file **một lần** (ghi vào bảng `schema_migrations` theo cặp `(id module, tên file)`), trong một giao dịch.
2. **Chỉ được tạo bảng đã khai báo trong `tables`.** Module nào tạo bảng lạ (ví dụ thiếu `bao_cao_tuan_extra` trong `tables`) thì Add bị từ chối với `Migration của module "..." tạo bảng chưa khai báo trong module.json: ...` và không bật gì cả.
3. Không được khai báo bảng của lõi (`tasks`, `runs`, `memories`...).
4. Đặt tên bảng với tiền tố id module để khỏi trùng. Dùng `CREATE TABLE IF NOT EXISTS` để chạy lại an toàn.
5. Khi cần thay đổi cấu trúc sau này, **thêm file mới** (`002_...sql`), đừng sửa `001`: file đã chạy sẽ không chạy lại.

Module chỉ được đụng bảng của mình qua `ctx.db` (cùng một SQLite với lõi). Đây là quy ước, không phải cơ chế cưỡng chế; đọc bảng của lõi thì dùng `ctx.tasks`, `ctx.memory`... thay vì SQL.

## 7.5 Bước 4. Phần server: `server/index.ts`

```ts
import { defineModule, type ModuleContext } from '../../../src/modules/sdk.js';

interface ReportRow {
  id: number;
  title: string;
  body: string;
  summary: string | null;
  task_id: number | null;
  created_at: string;
}

const WEEKLY_PROMPT =
  'Viết báo cáo tuần: đọc Second Brain và hoạt động gần đây của đội, trả lời đúng cấu trúc của skill bao-cao-tuan-skill.';

function saveReport(ctx: ModuleContext, title: string, body: string, taskId: number | null): number {
  const clean = ctx.outbound.sanitize(body);
  const info = ctx.db.prepare('INSERT INTO bao_cao_tuan_reports (title, body, task_id) VALUES (?, ?, ?)').run(title, clean, taskId);
  ctx.events.emit('report-added', { id: Number(info.lastInsertRowid) });
  return Number(info.lastInsertRowid);
}

/** Tạo một Task (không phải lượt lean): agent được dùng công cụ theo quyền, và có thể đọc Second Brain. */
function startWeekly(ctx: ModuleContext, agentId: string) {
  return ctx.tasks.create({
    agentId,
    title: 'Báo cáo tuần',
    prompt: WEEKLY_PROMPT,
    trigger: 'module',
    meta: { kind: 'weekly' },
  });
}

const latest = (ctx: ModuleContext): ReportRow | undefined =>
  ctx.db.prepare('SELECT * FROM bao_cao_tuan_reports ORDER BY id DESC LIMIT 1').get() as ReportRow | undefined;

export default defineModule({
  routes(app, ctx) {
    app.get('/reports', (c) => c.json({ items: ctx.db.prepare('SELECT * FROM bao_cao_tuan_reports ORDER BY id DESC LIMIT 50').all() }));

    app.post('/generate', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { agentId?: string };
      const agentId = body.agentId ?? ctx.settings.get<string>('reporterId', 'bao-cao-tuan-helper');
      if (!ctx.agents.get(agentId)) return c.json({ error: { code: 'not_found', message: `Không tìm thấy agent "${agentId}".` } }, 404);
      if (!ctx.access.can(agentId, 'report.write')) {
        return c.json({ error: { code: 'forbidden', message: `Agent "${agentId}" chưa được cấp quyền report.write.` } }, 403);
      }
      const task = startWeekly(ctx, agentId);
      return c.json({ taskId: task.id }, 202);
    });

    // Lượt lean: một câu hỏi, không công cụ, chờ kết quả ngay.
    app.post('/reports/:id/summary', async (c) => {
      const row = ctx.db.prepare('SELECT * FROM bao_cao_tuan_reports WHERE id = ?').get(c.req.param('id')) as ReportRow | undefined;
      if (!row) return c.json({ error: { code: 'not_found', message: 'Không có báo cáo này.' } }, 404);
      const agentId = ctx.settings.get<string>('reporterId', 'bao-cao-tuan-helper');
      if (!ctx.access.can(agentId, 'report.read')) {
        return c.json({ error: { code: 'forbidden', message: `Agent "${agentId}" chưa được cấp quyền report.read.` } }, 403);
      }
      const res = await ctx.agents.runLean({
        agentId,
        title: `Tóm tắt báo cáo #${row.id}`,
        prompt: 'Tóm tắt báo cáo trong dữ liệu module bằng một câu tiếng Việt.',
        moduleContext: row.body,
        timeoutMs: 120_000,
      });
      if (!res.ok) return c.json({ error: { code: 'internal', message: res.error ?? 'Agent không trả lời được.' } }, 502);
      const summary = ctx.outbound.sanitize(res.output);
      ctx.db.prepare('UPDATE bao_cao_tuan_reports SET summary = ? WHERE id = ?').run(summary, row.id);
      return c.json({ summary });
    });
  },

  start(ctx) {
    // Timer tạo qua ctx.schedule tự dừng khi Remove; công tắc nằm trong cài đặt nên bật/tắt không cần khởi động lại.
    ctx.schedule.every('weekly', '0 8 * * 1', () => {
      if (!ctx.settings.get<boolean>('autoWeekly', false)) return;
      const agentId = ctx.settings.get<string>('reporterId', 'bao-cao-tuan-helper');
      if (ctx.access.can(agentId, 'report.write')) startWeekly(ctx, agentId);
      else ctx.log.warn({ agentId }, 'agent chưa có quyền report.write, bỏ qua báo cáo tuần');
    });
  },

  // Task do module tạo và đã xong: lưu câu trả lời cuối thành một dòng báo cáo.
  onTaskFinished(task, _run, ctx) {
    if (task.meta.kind !== 'weekly' || task.status !== 'done' || !task.result) return;
    saveReport(ctx, `Báo cáo tuần ${task.createdAt.slice(0, 10)}`, task.result, task.id);
  },

  // Thêm dữ liệu của module vào prompt của việc do chính module tạo (source = module:bao-cao-tuan).
  contextFor(_task, ctx) {
    const r = latest(ctx);
    return r ? `Báo cáo gần nhất (${r.created_at.slice(0, 10)}): ${r.title}` : '';
  },

  // Hành động agent gọi bằng <aios-action module="bao-cao-tuan" name="report.save">{...}</aios-action>.
  actions: {
    'report.save': {
      scope: 'report.write',
      description: 'Lưu một báo cáo tuần vào module Báo cáo tuần.',
      example: { title: 'Báo cáo tuần 43', body: 'Kết luận: tình hình ổn…' },
      handler(payload, call, ctx) {
        const p = payload as { title?: unknown; body?: unknown };
        if (typeof p.title !== 'string' || typeof p.body !== 'string' || !p.title.trim() || !p.body.trim()) {
          throw new Error('Cần "title" và "body" là chuỗi không rỗng.');
        }
        return { id: saveReport(ctx, p.title.trim().slice(0, 120), p.body, call.taskId) };
      },
    },
  },

  // Khối ngắn nạp vào MỌI lượt chạy của agent có ít nhất một scope của module này.
  agentContext({ scopes }, ctx) {
    if (!scopes.includes('report.read') && !scopes.includes('*')) return undefined;
    const r = latest(ctx);
    return r ? `Báo cáo tuần gần nhất: "${r.title}" (${r.created_at.slice(0, 10)}).` : 'Chưa có báo cáo tuần nào.';
  },

  provides: (ctx) => ({
    latestReport: () => latest(ctx) ?? null,
  }),
});
```

Đi từng móc của SDK (`ModuleDefinition`, `src/modules/sdk.ts:166`):

### `routes(app, ctx)`

Gắn vào sub-app Hono phục vụ ở `/api/m/<id>/*`. Chỉ phục vụ khi module **đã Add và đang chạy**; nếu không, trả 404 `Module "x" chưa được thêm` (`manager.ts:323`, `mount`). Ví dụ `GET /api/m/bao-cao-tuan/reports`.

Hai kiểu gọi agent trong ví dụ:

| Kiểu | Hàm | Khi dùng |
|---|---|---|
| **Task thường, bất đồng bộ** | `ctx.tasks.create({...})` (`/generate`) | Việc dài: agent có công cụ, đọc Second Brain, chạy một lúc. Nhận kết quả ở `onTaskFinished`. `source` bị ép thành `module:<id>` |
| **Lượt `lean`, đồng bộ** | `ctx.agents.runLean({...})` (`/reports/:id/summary`) | Một câu hỏi ngắn, không công cụ, chờ kết quả ngay (`src/modules/context.ts:38`). Vẫn đi qua Engine: có phân quyền, có Run, tính chi phí |

`runLean` trả `{ ok, output, taskId, runId, error?, usage? }`; khi hết giờ chờ nó huỷ Task và trả `ok: false`, không ném lỗi.

**Luôn kiểm quyền trước khi đưa dữ liệu cho agent**: `ctx.access.can(agentId, 'report.write')`. Ví dụ trên trả 403 nếu agent thiếu scope.

**Luôn làm sạch trước khi dữ liệu rời hệ thống**: `ctx.outbound.sanitize(text)` (`src/modules/outbound.ts:11`) gỡ khoá bí mật, đường dẫn máy, mã màu terminal và thẻ chỉ thị `<aios-...>`. Ở đây ta dùng nó cho báo cáo lưu vào bảng.

### `start(ctx)` và `stop(ctx)`

`start` chạy khi Add và khi khởi động nếu module đang bật; `stop` chạy khi Remove và khi tắt hệ thống. Dùng cho worker nền, poller, tiến trình con. **Timer nên tạo bằng `ctx.schedule.every(tên, mốc, hàm)`**: `mốc` là số mili giây hoặc biểu thức cron, và timer **tự dừng khi Remove** (`context.ts:129`), nên bạn không phải nhớ dọn. Tương tự `ctx.events.on(...)`.

Trong ví dụ, lịch chạy mỗi thứ Hai 8:00 nhưng chỉ làm việc khi cài đặt `autoWeekly` bật, nên bạn bật tắt không cần khởi động lại.

Lỗi trong `start` **không làm sập hệ thống**: nó được lưu lại và hiện ở trang Module (`ModuleInfo.error`).

### `onTaskFinished(task, run, ctx)`

Được gọi cho mọi Task kết thúc có `source = module:<id>` của **chính module này** (`manager.ts`, bộ lọc `task.source !== source`). Đây là nơi nhận kết quả: kiểm `status`, đọc `task.result`, ghi vào bảng. Ném lỗi ở đây chỉ bị ghi log, không ảnh hưởng Task.

### `contextFor(task, ctx)`

Thêm dữ liệu module vào prompt của Task do module tạo. Khối này tự được lọc theo quyền vì chỉ chạy cho agent đang xử lý Task của module. Bài 6 so sánh với `agentContext`.

### `actions`

Hành động mà **agent** gọi từ câu trả lời (bài 5): `<aios-action module="bao-cao-tuan" name="report.save">{...}</aios-action>`. Mỗi hành động khai báo `scope` cần có, `description` tiếng Việt (hiện trong prompt của agent), `example` và `handler(payload, call, ctx)`. Engine kiểm scope trước, ghi kết quả vào bình luận Task và nhật ký. **Kiểm tra payload trong handler** (nó đến từ mô hình, đừng tin): ví dụ ném lỗi nếu thiếu `title`. Ném lỗi là cách báo lỗi cho agent, nó thấy trong bình luận.

### `agentContext({ agent, task, scopes }, ctx)`

Khối ngắn (tối đa 3.000 ký tự) nạp vào **mọi** lượt chạy của agent có ít nhất một scope của module. **Phải lọc theo `scopes`**: ví dụ trên chỉ trả dữ liệu khi có `report.read`, còn không trả `undefined` (không đưa gì).

### `provides(ctx)`

Dịch vụ cho **module khác** gọi qua `ctx.modules.get('bao-cao-tuan')`. Module khác chỉ thấy khi module này **đang bật**; luôn kiểm `undefined`. Đây là cách `care` nhận kênh từ `zalo` và `gmail` (bài 8). Đừng import mã của module khác.

### Còn lại trong `ctx`

| Nhóm | Dùng để |
|---|---|
| `ctx.id`, `ctx.manifest`, `ctx.dir`, `ctx.dataDir` | Thông tin module; `dataDir` là `data/modules/<id>/` cho media, cache |
| `ctx.db`, `ctx.log` | SQLite chung, logger |
| `ctx.agents.list/get` | Xem agent |
| `ctx.access.can/canIn` | Kiểm scope của module mình hoặc module khác |
| `ctx.connections.secret/composio/has` | Đọc khoá từ `.env`, dùng Composio |
| `ctx.memory.add/recall`, `ctx.brain.search` | Bộ nhớ và Second Brain (module tự lo kiểm quyền agent) |
| `ctx.settings.get/set/all` | Cài đặt của module |
| `ctx.events.emit/on` | Sự kiện: tên tự gắn tiền tố `<id>:` |
| `ctx.audit.log` | Ghi nhật ký (actor mặc định `module:<id>`) |
| `ctx.attention.raise/resolve` | Đưa việc vào **Cần bạn** trên Tổng quan |
| `ctx.crypto.encrypt/decrypt` | Mã hoá dữ liệu nhạy cảm |

## 7.6 Bước 5. Phần web: `web/index.tsx`

```tsx
import { NotebookPen } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { apiGet, apiPost } from '@/lib/api';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { defineWebModule, type WebNavItem } from '@/module-host/contracts';

// lucide's icon props accept string sizes, the host contract only numbers: cast once here
const icon = NotebookPen as unknown as WebNavItem['icon'];

interface Report {
  id: number;
  title: string;
  body: string;
  summary: string | null;
  created_at: string;
}

const LIST = '/api/m/bao-cao-tuan/reports';

function ReportsPage() {
  const { data, loading, error } = useFetch<{ items: Report[] }>(LIST);
  const generate = async () => {
    await apiPost('/api/m/bao-cao-tuan/generate');
    invalidateFetchCache(LIST);
  };
  return (
    <div>
      <PageHeader title="Báo cáo tuần" breadcrumb="Module" />
      <div class="p-4">
        <button class="rounded border px-3 py-1 text-sm" onClick={generate}>Tạo báo cáo ngay</button>
      </div>
      {loading && <p class="p-4 text-sm">Đang tải…</p>}
      {error && <p class="p-4 text-sm">Lỗi: {error}</p>}
      <ul class="p-4 space-y-2">
        {(data?.items ?? []).map((r) => (
          <li key={r.id} class="rounded border border-[var(--color-border)] p-3 text-sm">
            <div class="font-medium">{r.title}</div>
            <div class="mt-1 whitespace-pre-wrap text-[var(--color-text-muted)]">{r.summary ?? r.body}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReportsWidget() {
  const { data } = useFetch<{ items: Report[] }>(LIST);
  return <div class="text-sm">Báo cáo tuần đã lưu: {data?.items.length ?? 0}</div>;
}

export default defineWebModule({
  id: 'bao-cao-tuan',
  nav: [{ group: 'ops', label: 'Báo cáo tuần', path: '/m/bao-cao-tuan', icon, badge: async () => (await apiGet<{ items: Report[] }>(LIST)).items.length }],
  routes: [{ path: '/m/bao-cao-tuan', component: ReportsPage }],
  widgets: [{ slot: 'dashboard', id: 'bao-cao-tuan-reports', title: 'Báo cáo tuần', component: ReportsWidget }],
  agentAccess: [
    { scope: 'report.read', label: 'Xem báo cáo', description: 'Agent được thấy báo cáo tuần gần nhất.' },
    { scope: 'report.write', label: 'Tạo báo cáo', description: 'Agent được tạo và lưu báo cáo tuần.' },
  ],
});
```

`defineWebModule` (`web/src/module-host/contracts.ts`) khai báo:

| Trường | Ý nghĩa |
|---|---|
| `nav` | Mục menu: `group` (nhóm), `label`, `path` (nên bắt đầu `/m/<id>`), `icon`, `badge` (hàm trả số, được hỏi định kỳ) |
| `routes` | `{ path, component }` theo mẫu của `wouter` |
| `widgets` | Thẻ trên trang **Tổng quan** (`slot: 'dashboard'`) |
| `agentAccess` | Nhãn và mô tả scope hiện ở tab Quyền của agent (không có thì lấy từ `module.json`) |
| `provides` | Điểm mở rộng cho module khác (ví dụ `care.channelPanel`) |

Giao diện dùng `@/lib/api` (`apiGet`, `apiPost`) và `useFetch`. Web của mọi module được Vite đóng gói sẵn (`import.meta.glob`), giao diện hỏi `/api/modules` để biết module nào đang bật và chỉ hiện menu và widget của module đó, **không cần khởi động lại** khi Add.

## 7.7 Bước 6. Agent mẫu và skill

```yaml
# agents/bao-cao-tuan-helper/agent.yaml
name: Người viết báo cáo tuần
description: "Viết báo cáo tuần ngắn gọn từ Second Brain và hoạt động của đội"
runtime: mock
runtime_options: {}
permission: safe
context: standard
reports_to: main
can_delegate: false
max_concurrent: 1
enabled: true
access:
  brain:
    cong-ty-a: { read: ["**"], write: [] }
  memory: { team: true, private: false }
  skills: [bao-cao-tuan-skill]
  connections: {}
  modules:
    bao-cao-tuan: [report.read, report.write]
```

```
# agents/bao-cao-tuan-helper/persona.md
Bạn là người viết báo cáo tuần của đội. Trả lời bằng tiếng Việt, ngắn gọn, thẳng vào việc. Chỉ dùng thông tin có trong Second Brain, bộ nhớ và hoạt động gần đây của đội; không bịa số liệu. Thiếu dữ liệu thì nói rõ là thiếu.
```

```markdown
# skills/bao-cao-tuan-skill/SKILL.md
---
name: bao-cao-tuan-skill
description: "Cấu trúc báo cáo tuần: kết luận một câu, ba số liệu, việc đã làm, rủi ro."
---

# Báo cáo tuần

1. **Kết luận** một câu: tuần này tốt, ổn hay đáng lo.
2. **Ba số liệu chính**, mỗi số kèm nguồn.
3. **Việc đã làm**, tối đa 5 gạch đầu dòng.
4. **Rủi ro và việc cần quyết định**, nêu rõ ai quyết.

Không quá một trang. Thiếu số liệu thì ghi "chưa có dữ liệu" thay vì đoán.
```

Khi Add với "cài agent mẫu" (`aios module add bao-cao-tuan --agents`), thư mục agent được chép sang `agents/`; id đã có thì bỏ qua. Skill vào thư viện chừng nào module còn bật (bài 6). Agent mẫu ở đây chạy `mock` để thử không tốn tiền; đổi sang `claude` khi dùng thật.

## 7.8 Bước 7. Test

Module test như phần còn lại: file `*.test.ts` đặt cạnh mã, trong `modules/*/server/` (cấu hình ở `vitest.config.ts`). Repo có sẵn bộ dựng `createTestHarness` (`src/modules/test-deps.ts`): một `AppDeps` giả trên SQLite bộ nhớ, đủ để chạy bộ quản lý module thật.

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModuleManager } from '../../../src/modules/contracts.js';
import { createModuleManager } from '../../../src/modules/manager.js';
import { createTestHarness, fakeAgent, type TestHarness } from '../../../src/modules/test-deps.js';
import type { Task } from '../../../src/core/types.js';

const MODULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ID = 'bao-cao-tuan';

let h: TestHarness;
let mgr: ModuleManager;
let app: Hono;

const withScopes = (scopes: string[]) =>
  fakeAgent('nguoi-viet', { access: { brain: {}, memory: { team: true, private: false }, skills: [], connections: {}, modules: { [ID]: scopes } } });
const tableExists = (t: string) => !!h.deps.db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(t);
const post = (url: string, body?: unknown) =>
  app.request(`/api/m/${ID}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

beforeEach(async () => {
  h = createTestHarness({ modulesDir: MODULES_DIR });
  mgr = createModuleManager(h.deps, { fromDist: false });
  (h.deps as { modules: ModuleManager }).modules = mgr;
  h.fakes.agents.set('nguoi-viet', withScopes(['report.read', 'report.write']));
  h.deps.db.prepare("INSERT INTO kv (key, value) VALUES ('noop', '1')").run();
  await mgr.add(ID);
  app = new Hono();
  mgr.mount(app);
});
afterEach(async () => {
  await mgr.stop();
  h.cleanup();
});

describe('bao-cao-tuan', () => {
  it('Add tạo bảng đã khai báo và mở route', async () => {
    expect(tableExists('bao_cao_tuan_reports')).toBe(true);
    const res = await app.request(`/api/m/${ID}/reports`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it('/generate cần scope report.write', async () => {
    h.fakes.agents.set('nguoi-viet', withScopes(['report.read']));
    const res = await post('/generate', { agentId: 'nguoi-viet' });
    expect(res.status).toBe(403);
    expect(h.fakes.tasks).toHaveLength(0);
  });

  it('/generate tạo Task source module:<id>, onTaskFinished lưu báo cáo', async () => {
    const res = await post('/generate', { agentId: 'nguoi-viet' });
    expect(res.status).toBe(202);
    const task = h.fakes.tasks[0]!;
    expect(task.source).toBe(`module:${ID}`);
    h.fakes.finish(task.id, 'done', 'Kết luận: tuần ổn.');
    const finished = { ...task, meta: { kind: 'weekly' } } as Task;
    for (const hook of h.deps.hooks.taskFinished) await hook(finished, null);
    const rows = (await (await app.request(`/api/m/${ID}/reports`)).json()) as { items: { body: string; task_id: number }[] };
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]).toMatchObject({ body: 'Kết luận: tuần ổn.', task_id: task.id });
  });

  it('hành động report.save cần payload hợp lệ và agentContext lọc theo scope', async () => {
    const action = h.deps.hooks.moduleActions!.get(`${ID}:report.save`)!;
    expect(action.scope).toBe('report.write');
    // handler có thể ném đồng bộ; engine bọc lời gọi trong try/catch nên test cũng bọc trong hàm async
    await expect((async () => action.run({ title: '' }, { agentId: 'nguoi-viet', taskId: 1, runId: null }))()).rejects.toThrow('title');
    const out = (await action.run({ title: 'Tuần 43', body: 'Nội dung' }, { agentId: 'nguoi-viet', taskId: 1, runId: null })) as { id: number };
    expect(out.id).toBe(1);

    const provide = h.deps.hooks.agentContext!.get(ID)!;
    const agent = h.fakes.agents.get('nguoi-viet')!;
    const task = { id: 1 } as Task;
    expect(await provide(agent, task, ['report.read'])).toContain('Tuần 43');
    expect(await provide(agent, task, ['report.write'])).toBeUndefined();
  });

  it('Remove giữ dữ liệu, Purge xoá bảng', async () => {
    await mgr.remove(ID);
    expect((await app.request(`/api/m/${ID}/reports`)).status).toBe(404);
    expect(tableExists('bao_cao_tuan_reports')).toBe(true);
    await mgr.purge(ID, ID);
    expect(tableExists('bao_cao_tuan_reports')).toBe(false);
  });
});
```

Chạy:

```bash
npx vitest run modules/bao-cao-tuan
# 5 passed
npm run typecheck        # kiểm tra cả mã server của module và web/index.tsx
```

Các mẹo trong test:

- `createModuleManager(h.deps, { fromDist: false })` + `mgr.add(ID)` chạy **đúng đường Add thật**: kiểm migration, tạo bảng, nạp mã, đăng ký móc.
- `mgr.mount(app)` cho phép gọi route bằng `app.request('/api/m/<id>/...')`, không cần mở cổng.
- Harness cho Task giả: `h.fakes.tasks`, `h.fakes.finish(id, 'done', 'kết quả')`, và `h.fakes.state.autoFinish` để tự hoàn thành mọi Task (dùng khi test `runLean`).
- Engine không chạy trong harness, nên hook `onTaskFinished` phải được gọi tay qua `h.deps.hooks.taskFinished`, như test trên làm.
- Hành động và `agentContext` được tra qua `h.deps.hooks.moduleActions` và `h.deps.hooks.agentContext` sau khi Add.

## 7.9 Bước 8. Add, dùng thử, Remove, Purge

Với API đang chạy (`npm run dev`):

```bash
npm run aios -- module add bao-cao-tuan --agents
# Đã thêm module bao-cao-tuan (migration: 1, agent mẫu: 1)

curl -s -XPOST localhost:4380/api/m/bao-cao-tuan/generate -H 'content-type: application/json' -d '{}'
# {"taskId":9}
curl -s localhost:4380/api/m/bao-cao-tuan/reports
# {"items":[{"id":1,"title":"Báo cáo tuần 2026-10-24","body":"Đã xử lý: Viết báo cáo tuần: ...","task_id":9,...}]}
curl -s -XPOST localhost:4380/api/m/bao-cao-tuan/reports/1/summary
# {"summary":"Đã xử lý: Tóm tắt báo cáo trong dữ liệu module bằng một câu tiếng Việt."}
```

Mở **Công việc** để thấy hai Task có `source = module:bao-cao-tuan`: Task `generate` (`standard`) và Task `summary` (`lean`). Mở **Module** để thấy module đang bật. (Câu trả lời trên là của runtime `mock`; với agent thật bạn nhận báo cáo thật.)

Add làm gì (`src/modules/manager.ts:240`), theo thứ tự:

1. Kiểm `requires`: thiếu thì dừng, nói rõ thiếu gì (mã 412).
2. Đọc và kiểm migration (luật 7.4), rồi chạy.
3. Nạp mã server, đăng ký móc (`onTaskFinished`, `contextFor`, `agentContext`, `actions`), thêm thư mục skill, gọi `provides` rồi `start`.
4. Chạy `migrate(ctx)` bằng mã nếu có (hiếm dùng).
5. Cài agent mẫu nếu được chọn.
6. Ghi dòng vào bảng `modules` (`enabled = 1`), ghi nhật ký `module.add`, phát sự kiện để giao diện hiện menu ngay.

Nếu nạp mã server lỗi thì module **không được bật** (Add ném lỗi trước khi ghi vào bảng `modules`); các bảng đã tạo ở bước 2 vẫn còn, và Add lại sau khi sửa mã sẽ chạy tiếp.

```bash
npm run aios -- module remove bao-cao-tuan
# Đã gỡ module bao-cao-tuan (dữ liệu được giữ lại).
curl -s -o /dev/null -w "%{http_code}\n" localhost:4380/api/m/bao-cao-tuan/reports     # 404
```

**Remove** gọi `stop`, dừng mọi timer và sự kiện đã đăng ký qua `ctx`, rút móc và skill, ẩn menu, **giữ nguyên dữ liệu**. Module khác đang cần nó (qua `requires.modules`) thì Remove bị từ chối.

**Purge** xoá dữ liệu: chỉ khi module đã Remove, và phải gõ lại đúng id để xác nhận.

```bash
curl -s -XPOST localhost:4380/api/modules/bao-cao-tuan/purge -H 'content-type: application/json' -d '{"confirm":"sai"}'
# {"error":{"code":"bad_request","message":"Nhập đúng id module \"bao-cao-tuan\" để xác nhận xoá dữ liệu."}}
curl -s -XPOST localhost:4380/api/modules/bao-cao-tuan/purge -H 'content-type: application/json' -d '{"confirm":"bao-cao-tuan"}'
# {"ok":true}
```

Purge xoá đúng các bảng trong `tables`, thư mục `data/modules/<id>/`, và dòng trong `modules` và `schema_migrations`; sau đó Add lại như mới. Vì vậy `tables` phải **đầy đủ**: bảng nào quên khai báo sẽ không bị xoá (và migration tạo ra nó đã bị từ chối ngay từ đầu).

## 7.10 Chạy bản build

`npm start` nạp module từ `dist/modules/<id>/server/index.js`, nên sau khi tạo hoặc sửa module phải `npm run build` rồi mới `npm start`. Ở chế độ `npm run dev` (TypeScript chạy trực tiếp) thì không cần build. Đã kiểm: sau `npm run build`, `dist/modules/bao-cao-tuan` có mặt và module được liệt kê khi `npm start`.

## 7.11 Danh sách kiểm tra module mới

- [ ] `module.json`: `tables` khớp từng bảng trong migration; `scopes` có nhãn tiếng Việt.
- [ ] Mọi route kiểm tham số và trả lỗi dạng `{ error: { code, message } }` bằng tiếng Việt.
- [ ] Trước khi đưa dữ liệu cho agent: `ctx.access.can(...)`. Trong `agentContext`: lọc theo `scopes`.
- [ ] Trước khi gửi ra ngoài: `ctx.outbound.sanitize`. Hành động ra ngoài mặc định là **nháp**, chỉ gửi khi có scope `*.send`.
- [ ] Hành động của agent (`actions`) kiểm payload cẩn thận.
- [ ] Timer dùng `ctx.schedule.every`; không tạo `setInterval` thô.
- [ ] Không import mã của module khác; trao đổi qua `provides`.
- [ ] Có test chạy qua `createModuleManager` (Add, route, hook, Remove, Purge).
- [ ] Không ghi khoá bí mật vào prompt hay nhật ký.

## Bài tập

1. Làm lại bài này từ đầu trên một bản sao của repo (hoặc dùng id khác). Chạy test và `npm run typecheck`. Rồi xoá bản sao.
2. Thêm cột `author TEXT` vào bảng: viết `002_add_author.sql` bằng `ALTER TABLE ... ADD COLUMN`. Gỡ rồi Add lại (hoặc khởi động lại API; Add khi module đang chạy thì không làm gì): migration nào được chạy? Vì sao không sửa `001_init.sql`?
3. Thêm route `DELETE /reports/:id` và test cho nó. Ai được xoá (agent hay người dùng)? Bạn cần kiểm quyền không?
4. Sửa migration để tạo thêm bảng `bao_cao_tuan_extra` nhưng **quên** khai báo trong `tables`. Gọi `module add`: thông báo lỗi là gì? Bảng `bao_cao_tuan_reports` có được tạo không?
5. Thêm hành động `report.list` (scope `report.read`) trả 5 báo cáo mới nhất. Vì sao hành động chỉ đọc vẫn cần scope?
6. (Mở rộng) Đúng như gợi ý của thiết kế: mỗi thứ Hai, agent đọc Second Brain và bảng hoạt động đội rồi viết báo cáo vào thư mục brain được phép ghi. Gợi ý: thêm quyền `write` cho thư mục brain vào agent mẫu, và để `onTaskFinished` kiểm tra `ctx.access`.
