# Module Zalo

Kết nối nick Zalo cá nhân bằng mã QR, giữ phiên ổn định, nhận tin, đồng bộ lịch sử, gửi tin, chống khoá nick và cấp **kênh Zalo** cho hộp thư của module `care`.

## Phạm vi: chỉ chat theo mặc định

Mặc định module chỉ làm chat: quét QR, nhận tin, đồng bộ lịch sử, gửi tin. Các tính năng marketing (**mẫu tin, gửi nhóm, gửi 1-1, sinh nhật**) **tắt ở mọi chỗ** cho đến khi chủ bật `marketingEnabled`:

- Cài đặt `marketingEnabled` mặc định `false`. Daemon cũng mặc định tắt: nó chỉ chạy worker marketing khi biến `ZALO_MARKETING_ENABLED=1` (supervisor đọc cài đặt ở mỗi lần bật daemon) hoặc khi AIOS đẩy cấu hình bật qua `/config`. Thiếu biến, chạy tay, cài mới đều là tắt.
- Khi tắt: menu marketing và các trang của nó biến mất; các đường `/api/m/zalo/{templates,media,group-broadcasts,list-broadcasts,birthday}` và `/threads/:id/birth-date` trả 404; đường sinh biến thể mẫu tin (gọi model) không chạy; `ZaloSender` từ chối mọi tin `bulk` (mã `MARKETING_OFF`), kể cả một lượt worker đang chạy dở khi công tắc vừa tắt.
- **Việc marketing đang chờ khi tắt:** không bị huỷ, không bị xoá, **không gửi**. Dòng chạy gửi nhóm, người nhận gửi 1-1, lời chúc sinh nhật vẫn ở trạng thái chờ và chỉ tiếp tục nếu chủ bật lại (lời chúc quá hạn vẫn bị bỏ theo `TOO_LATE` như cũ). Hàng chờ `zalo_outbox` là của tin chat tay và agent, không phải của marketing, nên không bị ảnh hưởng.
- **Máy cài từ trước:** mặc định cũ là bật. Lúc khởi động, nếu máy chưa từng lưu giá trị `marketingEnabled` mà đã có dữ liệu marketing (mẫu tin, chiến dịch, lời chúc, hoặc sinh nhật đang bật), module lưu `true` để mọi thứ chạy như trước. Máy đã có giá trị tự đặt thì giữ nguyên; máy không có dữ liệu marketing thì nhận mặc định mới (tắt).
- Lõi chat (`session`, `ingest`, `history`, `sender`, `care-bridge`, `limits`, `store`, `connectors/zalo/*`…) **không import** file marketing (`template`, `variants`, `group-broadcast`, `list-broadcast`, `birthday*`, `broadcast-cost`, `schedule`, `send-window`, `marketing-deps`); `architecture.test.ts` giữ điều đó. Việc đọc ngày sinh từ hồ sơ khách đi qua hàm tuỳ chọn `onContactSeen` mà `daemon.ts` truyền vào, và chỉ làm khi marketing bật.
- Các file marketing vẫn nằm trong module (để gộp sửa lỗi từ bản gốc dễ). Không chép chúng, hay bất cứ file nào của module này, sang lõi hoặc `modules/care`: cả thư mục là AGPL-3.0-only.

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
- **Tin đến:** daemon đệm tin websocket của mỗi nick; `care` đọc qua `connector.sync()` (feed) rồi xác nhận bằng `commit()`. Tin đồng thời vẫn được lưu vào `zalo_messages` (lịch sử chat, và nguồn cho marketing nếu bật).
- **Tin đi:** `connector.dispatch()` → route `/care/accounts/:id/send` của daemon → `api.sendMessage` qua bộ giới hạn chống khoá (trần ngày, giờ nghỉ, khoá nick). Mỗi lần gửi được ghi một lần theo `requestId`, gửi lại cùng yêu cầu không gửi lần hai.
- **Mã tài khoản:** `care` dùng thẳng `zalo_accounts.id` làm mã tài khoản (không có bảng cầu nối).
- **Ảnh và PDF cho lượt agent:** `care` tự lấy qua `connector.fetchAttachment` (chỉ CDN Zalo) trong `modules/care/server/application/turn-media.ts`: tối đa 4 ảnh và 2 PDF gần nhất của khách, chép vào thư mục tạm và xoá khi lượt kết thúc. `provides.turnImages()` cũ không còn ai gọi.
- **Không có `care`:** Zalo vẫn lưu tin và quản lý nick (và chạy marketing nếu chủ đã bật). **Agent không bao giờ chạy trong module này**; không còn đường trả lời riêng (đã bỏ `responder`, `gate`, `agent-turn`).
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
| `marketingEnabled` | **tắt** | Công tắc tổng cho mẫu tin, gửi nhóm, gửi 1-1, sinh nhật. Đổi là có hiệu lực trong vài giây, không cần khởi động lại (xem mục Phạm vi). |
| `controlPort` | 4381 | Cổng điều khiển nội bộ (chỉ 127.0.0.1). Đổi thì Remove rồi Add lại module. |

Quyền cho agent (`access.modules.zalo`): `messages.read`, `broadcast.manage`.

## Giao diện và API

| Trang | Đường dẫn | Nhóm menu |
|---|---|---|
| Zalo · Tài khoản | `/m/zalo` | Sales |
| Mẫu tin Zalo | `/m/zalo/templates` | Marketing, chỉ khi bật `marketingEnabled` |
| Gửi nhóm | `/m/zalo/group-broadcasts` | Marketing, chỉ khi bật `marketingEnabled` |
| Gửi 1-1 | `/m/zalo/list-broadcasts` | Marketing, chỉ khi bật `marketingEnabled` |
| Sinh nhật | `/m/zalo/birthday` | Marketing, chỉ khi bật `marketingEnabled` |

API chat ở `/api/m/zalo/*`: `status`, `settings`, `accounts[/:id[/:action]]`, `accounts/:id/usage` (tin đã gửi hôm nay và trần của nick), `threads`, `search`, `overview`. API marketing (`templates`, `media`, `group-broadcasts`, `list-broadcasts`, `birthday`) trả 404 khi `marketingEnabled` tắt; khi bật, các nhóm này có worker riêng chạy trong daemon.

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
