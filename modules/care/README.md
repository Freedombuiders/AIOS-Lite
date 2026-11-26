# care — Chăm sóc khách hàng

Hộp thư chung cho mọi kênh (Zalo, Gmail…). Agent soạn nháp hoặc tự trả lời, bạn duyệt khi cần; mỗi khách có một hồ sơ chung cho các kênh.

## Dùng thế nào

1. **Add** module `care`, chọn "cài agent mẫu" để có agent `cskh` (Claude Haiku, `lean`) và skill `tra-loi-khach`.
2. Add module kênh (`zalo`, `gmail`). Mỗi kênh tự đăng ký với `care` khi `care` đã bật.
3. Vào **Kênh & agent**, gán agent cho tài khoản và chọn chế độ: *Chỉ theo dõi*, *Soạn nháp* (mặc định) hoặc *Tự động*.
4. Tin khách đến → agent soạn → nháp hiện ở **Nháp chờ duyệt** (và mục "Cần bạn" ở Tổng quan) → bạn duyệt, sửa rồi gửi.

Màn hình: Hộp thư · Nháp chờ duyệt · Khách hàng · Việc chăm sóc · Kênh & agent · Quy tắc · Nhật ký CSKH (menu Sales, đường dẫn `/m/care/...`). Widget Tổng quan: "Khách đang chờ", "Nháp chờ duyệt".

### Hộp thư ba cột (`/m/care/inbox[/:id]`)

Trái: chọn nick (trạng thái kết nối, số tin đã gửi trên trần hôm nay từ `GET /api/m/zalo/accounts/:id/usage`), ô tìm, bộ lọc Tất cả / Chưa đọc / Chưa trả lời, danh sách. Giữa: lịch sử (bốn loại người gửi `customer`, `self`, `operator`, `agent`; tin `self` ghi "gửi ngoài app"), nháp của bot trên ô nhắn, ô nhắn chỉ có chữ. Phải: bảng bot. Các trang khác của `care` nằm trong menu `⋯` ở đầu cột trái. Trang tự khai `hideCommandBar`. Ở bề ngang điện thoại ba cột thành ba màn chồng (danh sách → cuộc chat → bot).

Mỗi dòng có **một** nhãn do máy chủ tính (`workflow.bot.label`, `workflow/bot-state.ts`), theo thứ tự ưu tiên:

| Nhãn | Khi nào |
|---|---|
| Chuyển cho bạn | có dấu chuyển giao T06 (khách đòi gặp người); chỉ chủ gỡ được |
| Chờ bạn duyệt | có nháp `draft` / `needs_review` đang chờ |
| Chưa gán bot | không có luật bật, chỉ theo dõi (`observe`), bot bị tắt ở cuộc chat này (`ai_mode = off`), nhóm, hoặc Telegram |
| Bot nhường bạn | đang trong tạm dừng, bạn đã tiếp quản, hoặc bạn vừa nhắn trong cửa sổ `humanPauseMinutes` của luật |
| Bot đang chăm | luật bật chế độ `draft` hoặc `auto` và không có gì giữ bot lại |

**Hai bộ chế độ khác nhau, gọi bằng một bộ từ.** Luật gán bot (`/assignments`, phạm vi "cả nick" hoặc luật riêng của cuộc chat) có `observe | draft | auto` = *Chỉ theo dõi · Soạn nháp · Tự trả lời*. Công tắc riêng của cuộc chat (`PUT /conversations/:id/ai`) có `off | draft | auto` = *Tắt bot · Soạn nháp · Tự trả lời*; ở đó `draft` là trần (không bao giờ tự gửi, dù luật cho `auto`) và `auto` nghĩa là theo luật. `GET /conversations/:id/bot` trả luật đang áp dụng, luật của nick, luật riêng, công tắc và các cài đặt hiển thị trong "Bot luôn giữ các luật này".

Nháp trên ô nhắn đi theo `/drafts/:id` (sửa: `PATCH` với `expectedRevision`, gửi: `POST …/approve`, bỏ: `POST …/discard`). Lý do bot dừng ở nháp (`stop.codes`) lấy từ lượt chạy tạo nháp. **Nguồn brain**: runtime GenBot không đọc brain của AIOS và lượt `lean` không ghi nguồn, nên `sources` luôn rỗng hôm nay; giao diện hiện nguồn khi một lượt chạy ghi được chúng (`decision.decision.sources`).

Mọi `skip_reason` của lượt chạy được dịch ở `locales/*.json` (`care.skip.*`). `application/agent-reasons.ts` liệt kê lý do của lượt chạy và trình biên dịch buộc `skip()`/`fail()` chỉ dùng lý do trong danh sách; test `botView.test.ts` thất bại nếu một lý do (kể cả của `eligibility.ts`) chưa có lời dịch.

## Quyền (scope)

| Scope | Ý nghĩa |
|---|---|
| `inbox.read` | Đọc hộp thư |
| `customers.read` / `customers.write` | Xem / sửa hồ sơ khách |
| `reply.draft` | Soạn nháp (bắt buộc để agent chạy) |
| `reply.send` | Tự gửi. Thiếu scope này, chế độ Tự động **hạ xuống Soạn nháp** |

Agent mẫu `cskh` chỉ có `inbox.read`, `customers.read`, `reply.draft`. Muốn tự gửi, thêm `reply.send` trong tab Quyền của agent.

## Cài đặt (module.json `settings`)

- **Cho agent trả lời khách** (`aiEnabled`): công tắc dừng khẩn cấp.
- **Cho phép chế độ Tự động gửi** (`autoSendEnabled`, **mặc định tắt**): tắt thì mọi thứ dừng ở nháp chờ bạn duyệt, kể cả quy tắc đặt chế độ Tự động. Cài đặt đã lưu từ trước giữ nguyên giá trị; máy chưa từng lưu cài đặt này sẽ chỉ soạn nháp.
- **Giờ nghỉ** (`quietHoursStart` / `quietHoursEnd`, mặc định 22:00–07:00): trong giờ nghỉ, Tự động quay về nháp.
- **Độ trễ khi tự gửi** (`autoDelaySeconds`, mặc định 10): khoảng thời gian bạn còn **Huỷ** được.
- **Cụm từ khách đòi gặp người thật** (`handoffKeywords`, mặc định "gặp nhân viên, gặp người thật, khiếu nại") và **thời gian tạm dừng** (`handoffPauseMinutes`, mặc định 60): xem dưới.
- **Chờ khách nhắn xong** (`turnDebounceSeconds`, mặc định 3): khách gửi nhiều tin liền nhau thì agent chạy một lượt cho cả loạt, sau tin cuối chừng này giây.

Tiếp quản một hội thoại (người thật nhận) dừng mọi lượt tự động của agent ở hội thoại đó; "Nhờ agent soạn" vẫn luôn tạo nháp. Người thật vừa trả lời thì agent nhường 30 phút. Các quy tắc khác (từ khoá cần duyệt, trần số câu trả lời…) nằm ở màn hình **Quy tắc**.

### Khách đòi gặp người, tạm dừng, tiếp quản, tắt AI

- **Khách đòi gặp người.** Tin của khách có một cụm trong `handoffKeywords` (không phân biệt hoa thường, có dấu hay không) thì ngay lúc lưu tin, trong cùng một giao dịch: không có lượt agent nào, hội thoại bị tạm dừng `handoffPauseMinutes` phút và chuyển sang **tiếp quản** (bạn nhận), tin tự động agent đang chờ gửi bị huỷ, nháp agent chưa duyệt bị bỏ, nháp đã duyệt mà chưa gửi quay về chờ xem lại, và bạn nhận một mục cần chú ý. Lượt agent đang chạy dở bị bỏ kết quả. Chỉ bạn trả lại được cho agent (tắt tiếp quản), việc đó cũng gỡ tạm dừng.
- **Tạm dừng có hạn** (`PUT /conversations/:id/pause` với `{ "minutes": 30 | 120 | null }`, `null` là tới khi bật lại; `DELETE /conversations/:id/pause` để chạy lại): agent không chạy, không gửi ở hội thoại đó. Tin tự động đang chờ gửi bị huỷ, không để dành gửi sau.
- **Tiếp quản** và **tắt AI ở hội thoại**: dừng hẳn tới khi bạn đổi lại; tin tự động đang chờ cũng bị huỷ.
- Tin chỉ có ảnh hoặc PDF mà agent không đọc được (ví dụ runtime chỉ nhận chữ): agent không trả lời mò, bạn nhận một mục cần chú ý. Prompt dài quá giới hạn của runtime cũng vậy.

## Cách agent trả lời

Mỗi lượt là một lượt `lean` (không công cụ, không nhớ phiên) qua `ctx.agents.runLean`. Prompt gồm chỉ dẫn, nội dung skill `tra-loi-khach`, khoảng 30 tin gần nhất trong khối `<untrusted>`, và yêu cầu trả đúng một JSON: `{"action":"reply","replies":[{"ref","text"}],"needsReview":false}`, `{"action":"skip","reason"}` hoặc `{"action":"handoff","reason"}`. Module kiểm tra lại JSON rồi mới lưu nháp hoặc gửi; agent không bao giờ tự gửi. Agent không được bịa giá hay hứa hẹn.

## Cho module kênh (provides)

`ctx.modules.get('care')?.careChannels`:

```ts
register(connector: CareConnector): void       // hợp đồng modules/_lib/care-kit; khoá là connector.kind ('gmail-composio', 'zalo-zca'…)
unregister(kind: string): void
ensureAccount({ id, channel: 'email' | 'zalo', connectorKind, label, address? }): { id: string; epoch: number }
  // tạo hoặc ánh xạ tài khoản care bằng CHÍNH id của kênh (id care = id kênh); idempotent
getActiveEpoch(accountId: string): number      // ném lỗi nếu tài khoản không có hoặc chưa active
ingest(event: NormalizedEvent): Promise<{ outcome: 'stored' | 'duplicate' | 'failed'; error?: string }>
  // resolve sau khi đã ghi bền; trùng eventId thì trả 'duplicate'; epoch tự điền nếu thiếu
listAccounts(channel?): CareAccountRecord[]
```

Trả lời gửi đi luôn qua `connector.dispatch()` của kênh nên giới hạn chống khoá nick nằm ở kênh. Connector có thể thêm `careManagedSync` (để `care` định kỳ gọi `sync()`) và `commitSync(accountId, result, { failedEventIds })`; mặc định kênh tự đẩy tin bằng `ingest`.

### Điểm mở rộng giao diện

Module kênh khai báo trong `provides` của web module; `care` render mọi component được cung cấp và component tự trả `null` nếu `channel` không phải của nó.

- `care.channelPanel` nhận `{ channel: string; accountId?: string }` (thêm `account` và `onChanged` để tiện dùng). Hiện trong thẻ tài khoản ở "Kênh & agent".
- `care.composerExtras` nhận `{ channel: string; threadId: string }` (thêm `thread`, `account`, `disabled`, `attachments`, `onAttachmentsChange`). Hiện ở hàng nút của khung trả lời.

Chi tiết kiểu: `web/lib/extension-points.ts`.

## Cấu trúc

- `server/`: `persistence/` (kho dữ liệu, mã hoá từng trường bằng khoá của module), `application/` (nhận tin, lượt agent, hộp thư gửi), `policy/`, `runtime/` (worker, cổng gửi), `api/`, `workflow/`, `ops/`.
- `migrations/001_init.sql`: toàn bộ bảng `care_*`.
- `agents/cskh`, `skills/tra-loi-khach`, `web/`.

Chi tiết những gì đã bỏ so với bản gốc: [PORTING.md](PORTING.md).

## Kiểm thử

`npx vitest run modules/care` (có e2e 6 kịch bản: tin đến → nháp → duyệt → gửi; tự động có Huỷ; thiếu `reply.send`; giờ nghỉ; tiếp quản).
