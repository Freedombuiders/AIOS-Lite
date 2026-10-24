# Module Zalo

Kết nối nick Zalo cá nhân bằng mã QR, giữ phiên ổn định, chống khoá nick, gửi tin hàng loạt và cấp **kênh Zalo** cho hộp thư của module `care`.

> **License: AGPL-3.0-only.** Module này chứa mã dẫn xuất từ ZaloCRM (AGPL-3.0), nên toàn bộ `modules/zalo/` theo AGPL-3.0 (xem `LICENSE` và `NOTICE`). Phần còn lại của AIOS-Lite giữ license riêng; module chỉ nói chuyện với lõi qua Module SDK và `provides`.

## Chạy như thế nào

```
AIOS (một tiến trình)                         Dịch vụ Zalo (tiến trình con riêng)
┌───────────────────────────┐   HTTP 127.0.0.1  ┌─────────────────────────────┐
│ routes /api/m/zalo/*      │ ───────────────▶  │ daemon.ts                   │
│ supervisor (start/stop,   │  header token     │  • giữ phiên zca-js mỗi nick │
│   tự khởi động lại)       │  mỗi lần chạy     │  • lưu tin vào zalo_*        │
│ ZaloCareConnector ────────┼──▶ care           │  • worker marketing          │
└───────────────────────────┘                   │  • care-bridge (feed + gửi)  │
            │  cùng một file SQLite (WAL)       └─────────────────────────────┘
            └───────────────────────────────────────────┘
```

- **Vì sao tách tiến trình** (giữ từ bản gốc): mỗi nick chỉ giữ được một phiên Zalo Web; khởi động lại AIOS không làm rớt cả đàn nick; `zca-js` là thư viện không chính thức, sập thì chỉ sập dịch vụ Zalo.
- **Add / Remove:** `start(ctx)` sinh token ngẫu nhiên, mở cổng điều khiển và spawn daemon (dev: `node --import tsx server/daemon.ts`; bản build: `dist/modules/zalo/server/daemon.js`). Daemon sập thì được bật lại với độ trễ tăng dần (1 → 2 → 5 → 15 → 30 giây). `stop(ctx)` gửi SIGTERM, chờ tối đa 5 giây rồi mới SIGKILL. Một daemon bị bỏ lại sau khi AIOS sập cứng sẽ bị dọn theo file pid trước khi bật daemon mới.
- **Dữ liệu:** phiên đăng nhập, media và log nằm trong `ctx.dataDir` (`data/modules/zalo/`). Phiên được mã hoá bằng `AIOS_ENCRYPTION_KEY` (cùng định dạng với lõi). Tin nhắn, hội thoại và các bảng marketing nằm trong 17 bảng `zalo_*` của module.
- **Remove** giữ nguyên dữ liệu; chỉ **Purge** mới xoá bảng.
- **Thông báo cho chủ:** daemon gom các tin cần báo (nick bị khoá gửi, chiến dịch tự tạm dừng) rồi AIOS đọc mỗi 5 giây và đưa lên **Cần bạn** (`ctx.attention.raise`).

## Nối vào `care`

- Khi `care` đã Add, `start()` gọi `ctx.modules.get('care').careChannels.register(connector)` với `ZaloCareConnector` (hợp đồng ở `modules/_lib/care-kit`). `stop()` gọi `unregister('zalo-zca')`. Nếu `care` được Add sau, vòng 5 giây tự đăng ký; Remove `care` thì tự gỡ.
- **Tin đến:** daemon đệm tin websocket của mỗi nick; `care` đọc qua `connector.sync()` (feed) rồi xác nhận bằng `commit()`. Tin đồng thời vẫn được lưu vào `zalo_messages` để chạy marketing.
- **Tin đi:** `connector.dispatch()` → route `/care/accounts/:id/send` của daemon → `api.sendMessage` qua bộ giới hạn chống khoá (trần ngày, giờ nghỉ, khoá nick). Mỗi lần gửi được ghi một lần theo `requestId`, gửi lại cùng yêu cầu không gửi lần hai.
- **Mã tài khoản:** `care` dùng thẳng `zalo_accounts.id` làm mã tài khoản (không có bảng cầu nối).
- **Ảnh và PDF cho lượt agent:** `care` tự lấy qua `connector.fetchAttachment` (chỉ CDN Zalo) trong `modules/care/server/application/turn-media.ts`: tối đa 4 ảnh và 2 PDF gần nhất của khách, chép vào thư mục tạm và xoá khi lượt kết thúc. `provides.turnImages()` cũ không còn ai gọi.
- **Không có `care`:** Zalo vẫn lưu tin, quản lý nick và chạy marketing. **Agent không bao giờ chạy trong module này**; không còn đường trả lời riêng (đã bỏ `responder`, `gate`, `agent-turn`).
- Giao diện: `provides['care.channelPanel']` là `ZaloChannelPanel`, `care` hiển thị trong thẻ tài khoản (trạng thái, đăng nhập QR, giới hạn từng nick, cài đặt chống khoá).

## Chống khoá nick

Giữ nguyên các con số đã chạy ở bản gốc (có test):

- Trần theo loại thao tác (tin nhắn 1000/ngày, tối đa 20 tin mỗi 30 giây, đọc nhóm, tra cứu người dùng, kết bạn…), sửa được theo từng nick.
- **Giờ nghỉ 22:00–07:00:** chiến dịch hoãn đến sáng.
- **Ngân sách marketing:** tối đa 60% trần tin mỗi ngày của nick.
- **Nuôi nick mới:** tuần 1 tối đa 30 tin/ngày, tuần 2 là 80, tuần 3 là 150.
- **Tự khoá nick** khi Zalo từ chối 3 lần liên tiếp trên ít nhất 2 hội thoại; bật lại "Cho phép gửi tin" để mở khoá.
- Danh sách từ chối nhận tin theo hội thoại.

## Cài đặt (module.json)

| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| `marketingEnabled` | bật | Công tắc tổng cho gửi nhóm, gửi 1-1, sinh nhật. Đổi là có hiệu lực trong vài giây, không cần khởi động lại. |
| `controlPort` | 4381 | Cổng điều khiển nội bộ (chỉ 127.0.0.1). Đổi thì Remove rồi Add lại module. |

Quyền cho agent (`access.modules.zalo`): `messages.read`, `broadcast.manage`.

## Giao diện và API

| Trang | Đường dẫn | Nhóm menu |
|---|---|---|
| Zalo · Tài khoản | `/m/zalo` | Sales |
| Mẫu tin Zalo | `/m/zalo/templates` | Marketing |
| Gửi nhóm | `/m/zalo/group-broadcasts` | Marketing |
| Gửi 1-1 | `/m/zalo/list-broadcasts` | Marketing |
| Sinh nhật | `/m/zalo/birthday` | Marketing |

API ở `/api/m/zalo/*`: `status`, `settings`, `accounts[/:id[/:action]]`, `threads`, `search`, `templates`, `media`, `group-broadcasts`, `list-broadcasts`, `birthday`. Nhóm marketing có worker riêng chạy trong daemon.

## Agent mẫu và skill

- Agent **`zalo-care`** (runtime `claude`, model `haiku`, context `lean`): quyền `care: inbox.read, reply.draft` và `zalo: messages.read`. Chỉ soạn; việc gửi do `care` quyết định.
- Skill **`zalo-reply`**: trong nhóm chỉ lên tiếng khi có người cần hỗ trợ, không bao giờ bịa giá, kết quả theo đúng mẫu JSON của `care` (`reply` | `skip` | `handoff`). Ảnh và PDF của khách được `care` gửi kèm lượt agent (`turn-media.ts`).

## Kiểm thử

```
npx vitest run modules/zalo          # server (daemon giả + daemon thật qua module manager) và web
npx tsc -p tsconfig.json --noEmit    # server
npx tsc -p web/tsconfig.json --noEmit
node scripts/check-provenance.mjs    # "ZaloCRM" chỉ được xuất hiện trong modules/zalo
```

- `supervisor.test.ts` dùng daemon giả (`server/test-fixtures/fake-daemon.mjs`): bật, sai token, sập rồi tự bật lại, tắt sạch, dọn daemon mồ côi.
- `index.test.ts` chạy **daemon thật** qua module manager (file SQLite, không nick, không gọi mạng Zalo): Add tạo đủ bảng và bật daemon, Remove tắt daemon và giữ dữ liệu, đăng ký và gỡ kênh với `care` giả.
- Kiểm thật (không nằm trong test): tạo mã QR thật mà không đăng nhập. Daemon trả ảnh QR (~22 KB base64, `phase: waiting`) rồi huỷ bằng `cancel-qr`.

## Giới hạn đã biết

- Trả lời có trích dẫn và dấu "đã xem" mặc định **tắt** (chưa kiểm chứng với dịch vụ Zalo thật); mã hỗ trợ có sẵn trong daemon (`ZALO_CARE_QUOTE=1`, `ZALO_CARE_SEEN=1`) nhưng connector chưa nối `resolveMessage`, nên chưa bật được từ giao diện.
- `server/daemon-bind.ts` là file duy nhất của module import trực tiếp `src/core/*`: daemon là tiến trình riêng nên phải tự mở cùng file SQLite. Nếu lõi thêm hàm `bindDaemonCompat(dbPath)` vào `src/modules/compat` thì xoá được file này.
