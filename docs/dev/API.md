# AIOS-Lite — Hợp đồng API

## Quy ước chung

- Kiểu dữ liệu nằm trong `src/core/types.ts`. Web import qua alias `@core/types`.
- **Base URL:** `/api`. Mọi request và response đều là JSON (UTF-8). Thời gian dùng ISO-8601 UTC.
- **Xác thực:** nếu đặt `AIOS_TOKEN` thì mọi request phải gửi header `Authorization: Bearer <token>`. SSE gửi token qua query `?token=`, vì EventSource không đặt được header. Server chỉ nghe trên `AIOS_HOST` (mặc định 127.0.0.1).
- **Lỗi:** HTTP 4xx/5xx kèm body `{ "error": { "code": string, "message": string } }`.

  | code | HTTP |
  |---|---|
  | `bad_request` | 400 |
  | `unauthorized` | 401 |
  | `forbidden` | 403 |
  | `not_found` | 404 |
  | `conflict` | 409 |
  | `requirements_missing` | 412 |
  | `internal` | 500 |

- **Danh sách:** trả về `{ "items": T[] }`. Tham số `limit` mặc định 50, tối đa 500. Phân trang dùng `beforeId`.
- **Route của module** nằm dưới `/api/m/<moduleId>/...`. Module chưa được Add thì trả 404 `not_found`.

---

## Hệ thống

| Method | Path | Body / Query | Trả về |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok: true, version: string, uptimeSec: number }` |
| GET | `/api/runtimes` | `?probe=1` để gửi thử "hello" | `{ items: (DoctorReport & { label: string; capabilities: RuntimeCapabilities })[] }` |
| GET | `/api/stats` | — | `StatsService.overview()` |
| GET | `/api/attention` | — | `{ items: AttentionItem[] }` |
| POST | `/api/attention/:key/resolve` | — | `{ ok: true }` |
| GET | `/api/settings` | — | `{ timezone, maxParallel, emergencyStop: boolean, version }` |
| PUT | `/api/settings` | `{ emergencyStop?: boolean }` | như GET. `emergencyStop=true` thì dispatcher ngừng nhận việc mới |

## Agents

| Method | Path | Body / Query | Trả về |
|---|---|---|---|
| GET | `/api/agents` | — | `{ items: AgentSummary[], errors: AgentLoadError[] }` |
| GET | `/api/agents/:id` | — | `AgentConfig & { stats: AgentStats }` |
| POST | `/api/agents` | `{ id, name, runtime, ...AgentInput }` | `AgentConfig` (201) |
| PUT | `/api/agents/:id` | `AgentInput` | `AgentConfig` |
| DELETE | `/api/agents/:id` | — | `{ ok: true }` (lưu trữ chứ không xoá hẳn) |
| POST | `/api/agents/reload` | — | `{ items: AgentSummary[], errors }` |
| GET | `/api/agents/:id/access` | — | `{ access: AccessSnapshot, enforcement: AccessEnforcement, runtime: RuntimeId }` |

Các kiểu phụ:
- `AgentSummary = Omit<AgentConfig,'persona'> & { stats: AgentStats }`
- `AgentStats = { running: number; queued: number; lastRunAt: string|null; costMonthUsd: number; runsMonth: number }`

## Kết nối

| Method | Path | Body | Trả về |
|---|---|---|---|
| GET | `/api/connections` | — | `{ items: (Connection & { ready: boolean; grantedTo: string[] })[] }`. **Không bao giờ trả giá trị secret**: các giá trị env bị thay bằng `"$NAME"` hoặc `"[set]"` / `"[missing]"` |
| POST | `/api/connections/:id/test` | — | `{ ok: boolean, message: string }` |
| PUT | `/api/connections/composio-key` | `{ apiKey: string }` | `{ ok: true }` (ghi `COMPOSIO_API_KEY` vào `.env`) |

## Công việc

| Method | Path | Body / Query | Trả về |
|---|---|---|---|
| GET | `/api/tasks` | `?status=queued,running&agentId=&parentId=&source=&kind=&q=&limit=&beforeId=` | `{ items: Task[] }` |
| POST | `/api/tasks` | `CreateTaskInput`; `source` bị server ép thành `'user'` hoặc `'api'` | `Task` (201) |
| POST | `/api/tasks/team` | `TeamTaskInput` | `Task` (task cha, 201) |
| GET | `/api/tasks/:id` | — | `{ task: Task, runs: Run[], children: Task[], comments: TaskComment[], parent: Task\|null }` |
| POST | `/api/tasks/:id/cancel` | — | `Task` |
| POST | `/api/tasks/:id/retry` | — | `Task` |
| POST | `/api/tasks/:id/approve` | — | `Task` (`review` → `done`) |
| GET | `/api/tasks/:id/comments` | — | `{ items: TaskComment[] }` |
| POST | `/api/tasks/:id/comments` | `{ body: string, requeue?: boolean }` (mặc định `requeue` = true) | `TaskComment` (201) |
| GET | `/api/tasks/counts` | — | `Record<TaskStatus, number>` |

## Lượt chạy

| Method | Path | Query | Trả về |
|---|---|---|---|
| GET | `/api/runs` | `?taskId=&agentId=&status=&limit=&beforeId=` | `{ items: Run[] }` |
| GET | `/api/runs/:id` | `?afterEventId=` | `{ run: Run, events: StoredRunEvent[], access: AccessSnapshot\|null }` |

## Lịch định kỳ

| Method | Path | Body | Trả về |
|---|---|---|---|
| GET | `/api/schedules` | — | `{ items: Schedule[] }` |
| POST | `/api/schedules` | `ScheduleInput` | `Schedule` (201); cron sai thì trả 400 |
| PUT | `/api/schedules/:id` | `Partial<ScheduleInput>` | `Schedule` |
| DELETE | `/api/schedules/:id` | — | `{ ok: true }` |
| POST | `/api/schedules/:id/run` | — | `Task` |

## Trò chuyện

| Method | Path | Body / Query | Trả về |
|---|---|---|---|
| GET | `/api/conversations` | `?agentId=` | `{ items: Conversation[] }` |
| POST | `/api/conversations` | `{ agentId, title? }` | `Conversation` (201) |
| GET | `/api/conversations/:id` | — | `{ conversation, messages: Message[] }` |
| PATCH | `/api/conversations/:id` | `{ title }` | `Conversation` |
| DELETE | `/api/conversations/:id` | — | `{ ok: true }` |
| POST | `/api/conversations/:id/messages` | `{ content }` | `{ message: Message, task: Task }` (201). Câu trả lời đến sau qua SSE |

## Second Brain

| Method | Path | Body / Query | Trả về |
|---|---|---|---|
| GET | `/api/brain/folders` | — | `{ items: (BrainFolder & { docs: number; exists: boolean })[] }` |
| GET | `/api/brain/tree` | `?folder=&depth=` | `{ items: BrainTreeNode[] }` |
| GET | `/api/brain/file` | `?folder=&path=` | `{ title, content, mtimeMs }` |
| GET | `/api/brain/search` | `?q=&folders=a,b&limit=` | `{ items: BrainHit[] }` |
| POST | `/api/brain/reindex` | `{ full?: boolean, folderId?: string }` | `{ indexed, removed, durationMs }` |

## Bộ nhớ

| Method | Path | Body / Query | Trả về |
|---|---|---|---|
| GET | `/api/memory` | `?scope=team\|private\|all&agentId=&q=&limit=` | `{ items: Memory[] }` |
| POST | `/api/memory` | `{ content, agentId: string\|null, pinned? }` | `Memory` (201) |
| PATCH | `/api/memory/:id` | `{ content?, pinned? }` | `Memory` |
| DELETE | `/api/memory/:id` | — | `{ ok: true }` |

## Skills, bảng đội, nhật ký

| Method | Path | Query | Trả về |
|---|---|---|---|
| GET | `/api/skills` | — | `{ items: (Skill & { usedBy: string[] })[] }` |
| GET | `/api/skills/:id` | — | `{ skill: Skill, content: string }` |
| GET | `/api/board` | `?limit=` | `{ items: BoardEntry[] }` |
| GET | `/api/audit` | `?actor=&action=&since=&limit=&beforeId=` | `{ items: AuditEntry[] }` |

## Module

| Method | Path | Body | Trả về |
|---|---|---|---|
| GET | `/api/modules` | — | `{ items: ModuleInfo[] }` |
| GET | `/api/modules/:id` | — | `ModuleInfo` |
| POST | `/api/modules/:id/add` | `AddOptions` | `AddResult`. Thiếu điều kiện thì trả 412 `requirements_missing`, `message` liệt kê những gì còn thiếu |
| POST | `/api/modules/:id/remove` | — | `ModuleInfo` |
| POST | `/api/modules/:id/purge` | `{ confirm: string }`; `confirm` phải đúng bằng id | `{ ok: true }` |
| GET | `/api/modules/:id/settings` | — | `Record<string, unknown>`. Giá trị loại `secret` bị che |
| PUT | `/api/modules/:id/settings` | `Record<string, unknown>` | `Record<string, unknown>` |

## Sự kiện trực tiếp

`GET /api/events` (SSE, `text/event-stream`):

- Mỗi sự kiện có `event: <type>` và `data: <JSON của AppEvent>`.
- Các type: `task`, `run`, `run-event`, `message`, `board`, `memory`, `attention`, `audit`, `module`, `custom`.
- Server gửi comment `: ping` mỗi 25 giây.
- Query `?types=task,run` để chỉ nhận một số loại.
- Client tự kết nối lại. Sau khi kết nối lại, client tự gọi các API đọc để lấy dữ liệu mới nhất; server không phát lại sự kiện cũ.
