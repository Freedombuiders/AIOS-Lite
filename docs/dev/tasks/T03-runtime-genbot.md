# T03 · Runtime `genbot`

> Nhánh Agent · 3 ngày · Phụ thuộc: không · Kế hoạch mục 5.1

## Mục tiêu

Một agent khai `runtime: genbot` thì mọi lượt chạy của nó đi qua Bot API của GenBot. Các module đang gọi `ctx.agents.runLean` không phải sửa.

## Làm và không làm

- Làm: bộ chuyển HTTP, đăng ký id ở mọi nơi, bộ giới hạn lượt gọi, `doctor`, test với máy chủ giả.
- Không làm: nối tiếp luồng GenBot giữa các lượt; trần lượt mỗi ngày và việc bỏ cầu MCP (T04).

## Đọc trước

- `genbot/desktop/docs/bot-api.md` (toàn bộ).
- `genbot/desktop/server/bot-api-host.ts`: tìm dạng trả về của `GET …/messages?thread=<id>`. Tài liệu không ghi.
- `src/runtimes/contracts.ts`, và một bộ chuyển sẵn có để theo cách viết (`src/runtimes/codex.ts`).

## File đụng tới

Bảng đầy đủ ở mục 5.1.2 của kế hoạch. Tóm tắt:

| File | Loại |
|---|---|
| `src/core/types.ts:3-4` | SỬA |
| `src/runtimes/genbot.ts`, `genbot.test.ts` | MỚI |
| `src/runtimes/index.ts`, `index.test.ts` | SỬA |
| `test-fixtures/runtimes/fake-genbot.mjs` | MỚI |
| `src/modules/compat/provider.ts:26` | SỬA |
| `web/src/lib/labels.ts`, `web/src/lib/teams.ts`, `web/src/pages/agents/AgentsPage.tsx:23`, `web/src/components/costs/format.ts:4` | SỬA |
| `modules/video/server/edit/turn.ts:9-10` | SỬA |
| `docs/lessons/04-them-runtime-moi.md`, `docs/dev/runtime-verification.md` | SỬA |

## Các bước

- [ ] Thêm `'genbot'` vào `RuntimeId` và `RUNTIME_IDS`. Chạy `npm run typecheck`, sửa mọi chỗ trình biên dịch báo.
- [ ] Viết `GENBOT_CAPABILITIES` (xem Hợp đồng).
- [ ] Viết `buildMessage(req)`: `systemPrompt + "\n\n" + prompt`. Dài hơn 20.000 ký tự thì trả lỗi `config`, lời nhắn có độ dài thật. Không tự cắt.
- [ ] Viết bộ giới hạn 10 lượt mỗi 60 giây, theo từng `key_env`, giữ trong bộ nhớ. Hết lượt thì chờ; chờ quá `timeoutMs` thì trả `quota` kèm `retryAfter`.
- [ ] Viết `run(req)`: `POST {base_url}/hooks/api/bots/{bot_id}/messages`, đầu `Authorization: Bearer <process.env[key_env]>`, thân `{ message, wait }` với `wait = min(120, floor(timeoutMs / 1000))`. Truyền `req.signal`.
- [ ] Đổi kết quả theo bảng ở mục 5.1.3 của kế hoạch.
- [ ] Trường hợp `202 working`: hỏi lại mỗi 2 giây tới khi có trả lời hoặc hết giờ.
- [ ] `doctor()`: không `probe` thì kiểm đủ ba giá trị cấu hình và thử kết nối tới `base_url`. Có `probe` thì gửi một tin thật.
- [ ] Phát `req.onEvent({ type: 'status', message })` ở ba mốc: đã gửi, đang chờ GenBot, đã nhận.
- [ ] Không bao giờ ghi khoá vào log, vào lỗi, hay vào `RunEvent`.
- [ ] Viết máy chủ giả và bộ test.
- [ ] Sửa bài học 04: số dòng đã lệch, ví dụ thiếu trường `documents`, và danh sách chỗ phải sửa ở giao diện thiếu.

## Hợp đồng

```ts
export const GENBOT_CAPABILITIES: RuntimeCapabilities = {
  resume: false,
  systemPrompt: 'inline',
  reportsCost: false,
  images: false,
  documents: false,
  noTools: true,
  enforces: {
    context: 'hard', mcp: 'hard', fileRead: 'hard', fileWrite: 'hard', shell: 'hard',
    note: 'Luồng Bot API của GenBot bị nhốt: không công cụ, không MCP, không đọc ghi file.',
  },
};
```

```yaml
# agents/<id>/agent.yaml
runtime: genbot
runtime_options:
  base_url: http://127.0.0.1:8800
  bot_id: bot_abc123
  key_env: GENBOT_KEY_CSKH
```

`RunResult.usage` luôn để trống. Không điền 0.

## Test

`genbot.test.ts`, mỗi dòng một ca:

- 200 trả `ok: true` và đúng `output`.
- 202 `working` rồi có trả lời.
- 202 `working` mãi tới hết giờ: `timeout`.
- 202 `needs_approval`: `access`.
- 401: `auth`. 403: `config`. 429: `quota` có `retryAfter`. 502: `unknown`.
- Máy chủ không nghe: `transient`.
- Huỷ giữa chừng: `cancelled`, và yêu cầu HTTP bị ngắt thật.
- Prompt 20.001 ký tự: `config`, không có yêu cầu HTTP nào đi.
- Lượt gọi thứ 11 trong một phút phải chờ.
- Thiếu `bot_id`: `config`.
- Khoá không xuất hiện trong bất kỳ chuỗi nào trả ra.

## Xong khi

- `npx vitest run src/runtimes` và `npm run typecheck` qua.
- Với GenBot thật đang chạy và một bot đã bật Bot API: agent trả lời ở `/chat`.
- `GET /api/runtimes` có `genbot` kèm kết quả `doctor`.

## Ghi chú

- Luồng mở qua Bot API hiện trong app GenBot. Mỗi lượt một luồng mới sẽ làm danh sách dài. Đây là hạn chế đã biết của bản đầu (kế hoạch mục 5.1.5).
- `engine.ts:190` chỉ nối skill vào thư mục làm việc cho `claude` và `grok`. Giữ nguyên; `genbot` không dùng skill của AIOS.
