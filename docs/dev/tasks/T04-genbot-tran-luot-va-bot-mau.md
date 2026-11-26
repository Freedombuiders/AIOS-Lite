# T04 · Trần lượt mỗi ngày, bỏ cầu MCP, ba bot mẫu

> Nhánh Agent · 2 ngày · Phụ thuộc: T03 · Kế hoạch mục 5.1.4

## Mục tiêu

Xử lý hai hệ quả của một runtime không báo chi phí và không có công cụ, rồi đóng gói ba bot mẫu để cài một lần là có đội.

## File đụng tới

| File | Loại |
|---|---|
| `src/work/engine.ts` (cạnh chỗ kiểm ngân sách, dòng 178) | SỬA |
| `src/work/runs.ts` | SỬA: thêm `dayCount(agentId)` |
| `src/access/policy.ts:67-77` | SỬA |
| `web/src/pages/agents/…` (tab Quyền, tab cấu hình) | SỬA |
| `teams/agenticos-doi-mac-dinh/` | MỚI |

## Các bước

- [ ] `runs.dayCount(agentId, tz)`: đếm lượt chạy trong ngày theo múi giờ cấu hình.
- [ ] Trong `engine.ts`: nếu `agent.runtimeOptions.max_runs_day` có giá trị (mặc định 500 khi `runtime` không báo chi phí) và đã chạm trần thì kết thúc lượt với `family: 'budget'`, lời nhắn nêu trần. Dùng lại đường xử lý lỗi `budget` sẵn có.
- [ ] Trong `policy.ts`: bỏ qua việc cấp `McpGrant` `aios-integrations` khi runtime của agent khai `enforces.mcp === 'hard'` và `noTools === true`. Hiện cầu này được cấp cho mọi lượt không `lean`.
- [ ] Tab Quyền của agent hiện dòng `enforces.note`, và ẩn phần cấp integration khi runtime không dùng được.
- [ ] Form agent: khi chọn `genbot`, hiện ba ô `base_url`, `bot_id`, `key_env`, và nút "Kiểm tra" gọi `doctor` có `probe`.
- [ ] Gói đội `teams/agenticos-doi-mac-dinh/` theo định dạng gói sẵn có (`TEAM.md`, thư mục `agents/`, `schedules.yaml`), gồm ba agent:
  - `bot-cskh`: `context: lean`, đọc `san-pham/**`, `chinh-sach/**`, `giong-noi.md`; scope `care: [reply.send]`.
  - `bot-noi-dung`: đọc `giong-noi.md`, `noi-dung/**`, `san-pham/**`, `bai-hoc/**`, `cong-thuc/**`.
  - `bot-tro-ly`: đọc toàn bộ; ghi `nho/**`.
- [ ] `persona.md` của từng bot chỉ nói vai trò và giọng điệu. Không lặp lại lược đồ JSON mà module đã đưa trong prompt.
- [ ] Viết `docs/huong-dan-noi-genbot.md`: tạo bot trong GenBot, bật Bot API, chép khoá vào `.env`, điền `bot_id`.

## Hợp đồng

```yaml
runtime_options:
  max_runs_day: 500     # tuỳ chọn; áp cho mọi runtime, mặc định chỉ bật khi runtime không báo chi phí
```

## Test

- `engine.test.ts`: lượt thứ 501 trong ngày kết thúc với `budget`; sang ngày mới chạy lại được.
- `policy.test.ts`: agent `genbot` không có `aios-integrations` trong `mcpServers`; agent `claude` vẫn có.
- Cài gói đội trong test: ba agent được tạo, hợp lệ theo `src/agents/schema.ts`.

## Xong khi

- Hai nhóm test trên xanh.
- Cài gói đội trên máy thật, điền ba `bot_id`, cả ba bot trả lời ở `/chat`.

## Ghi chú

Bot Trợ lý cần tạo việc và nhắc lịch. Nó làm được mà không cần công cụ: engine hiểu chỉ thị `<aios-action module= name=>` trong câu trả lời (`engine.ts:108-123`). Lượt `lean` chỉ nhận chỉ thị `status`, nên Bot Trợ lý phải để `context: standard`.
