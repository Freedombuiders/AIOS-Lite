# AIOS-Lite — Danh mục module (bản chốt)

> **Bản 1, 24/10/2026.** Cách một module hoạt động (cấu trúc thư mục, SDK, vòng đời Add/Remove) nằm ở [ARCHITECTURE.md](ARCHITECTURE.md) §9.
> Năm module dưới đây mang nghiệp vụ đã chạy thật ở bản gốc (FreedomOS) sang, **viết lại trên Module SDK** theo quy tắc ở ARCHITECTURE §14.

| Module | Nhóm menu | Cần có | Làm việc cùng | Kích thước thực (server + web, không kể test) |
|---|---|---|---|---|
| `care`: Chăm sóc khách hàng | Sales | — | `zalo`, `gmail` cung cấp kênh | ~33k dòng (24k + 9k) |
| `zalo`: Zalo | Sales | — | cấp kênh cho `care` | ~18k dòng (14k + 4,6k) |
| `gmail`: Gmail | Sales | module `care` + khoá Composio | — | ~5k dòng (4,8k + 0,4k) |
| `marketing`: Facebook Content Studio | Marketing | khoá Composio (Facebook) | `ads` dùng số liệu bài đăng | ~14k dòng (9k + 5,4k) |
| `ads`: Quảng cáo Meta (chỉ đọc) | Marketing | khoá Composio (Meta Ads) | `marketing` | ~6k dòng (3,9k + 2,5k) |
| `_template` | — | — | khuôn để học viên tạo module mới | ~140 dòng |

Để dành cho sau (bản gốc có, lần này chưa mang): KOL Studio, Video Studio, Radar thị trường, Thu chi/P&L, ERP.

> **Tên bảng:** các danh sách bảng bên dưới chỉ là nhóm chức năng. Khi copy, module **giữ nguyên tên bảng của bản gốc** (ví dụ `fb_*` cho `marketing` và `ads`, `email_*` cho `gmail`). Danh sách chính xác được khai báo trong `module.json` (`tables`).
> **Kế hoạch build và danh sách task:** [dev/BUILD-PLAN.md](dev/BUILD-PLAN.md), [dev/TASKS.md](dev/TASKS.md).

---

## Quy ước chung cho module có agent trả lời khách

Ba module `care`, `marketing` (bình luận) và `zalo` (khi đi qua `care`) dùng chung cách làm sau. Cách này đúc kết từ bản gốc.

1. **Agent không tự gửi gì ra ngoài.**
   - Module tạo một Task `lean` kèm dữ liệu cần thiết.
   - Agent trả về **JSON** dạng `{action: reply|handoff|skip, text, reason}`.
   - Module đọc JSON trong `onTaskFinished`, kiểm tra lại, rồi mới gửi hoặc lưu nháp.
2. **Lượt trả lời khách là lượt không tin cậy.**
   - Không có công cụ, chỉ một lượt.
   - Không nối phiên; mỗi lượt gửi lại khoảng 30 tin gần nhất trong khối `<untrusted>`.
   - Nội dung skill được chép thẳng vào prompt.
3. **Ba chế độ cho mỗi tài khoản hoặc hội thoại:**
   - **Chỉ theo dõi:** agent không làm gì.
   - **Soạn nháp:** mặc định.
   - **Tự động:** gửi sau vài giây và có nút Huỷ.

   Chế độ tự động **quay về nháp** khi: gặp từ khoá cần duyệt, agent trả `handoff`, hoặc kiểm tra trước khi gửi bị lỗi. **Giờ nghỉ** xử lý theo kênh: Zalo chuyển câu trả lời thành nháp, còn email **hoãn** trả lời đến hết giờ nghỉ (`quietHoursMode: 'defer'`).
4. **Người thật luôn được ưu tiên.**
   - Người thật vừa trả lời thì agent nhường trong 30 phút.
   - Người thật trả lời trong lúc agent đang soạn thì câu của agent bị bỏ.
5. **Bộ lọc rẻ chạy trước, LLM chạy sau:**
   - Bỏ qua lời đáp ngắn ("ok", "dạ", 👍).
   - Khách nói "đừng nhắn nữa" thì đánh dấu **từ chối nhận tin** và không nhắn nữa.
   - Áp trần số câu trả lời mỗi ngày cho từng agent và từng hội thoại.
   - Chống hai AI nói chuyện với nhau: bỏ qua tin đến từ nick nội bộ.
6. **Quyền:** để tự gửi, agent cần scope `reply.send`. Chỉ có `reply.draft` thì chế độ Tự động bị hạ xuống Soạn nháp.
7. **Không bịa giá hay hứa hẹn.** Điều này được ghi trong prompt và trong skill mẫu.

---

## 1. `care`: Chăm sóc khách hàng (hộp thư chung)

**Mục đích:** một hộp thư cho mọi kênh (Zalo, Gmail…), agent soạn hoặc tự trả lời, người duyệt khi cần, và hồ sơ khách 360.

**Tính năng**, mang từ Care Inbox v2 cùng phần chăm sóc của Zalo và Email ở bản gốc:
- **Hộp thư chung:**
  - Các tab Cần trả lời / Chờ khách / Tạm hoãn / Đã xong.
  - Tìm kiếm, lọc theo kênh, tài khoản, người phụ trách, chưa đọc; lọc "Quá 5 phút".
  - Gửi tay; nút **Nhờ agent soạn** (luôn tạo nháp).
- **Theo từng hội thoại:**
  - Chọn chế độ AI, gán người hoặc agent phụ trách.
  - **Tiếp quản**: người thật nhận hội thoại, AI tạm dừng.
  - Tạm hoãn đến một giờ cụ thể.
- **Nháp chờ duyệt:** duyệt, sửa rồi gửi, hoặc bỏ. Nháp mới thay nháp cũ trong cùng hội thoại.
- **Khách hàng 360:**
  - Hồ sơ (tên, SĐT, công ty, nguồn, nhãn, người phụ trách, tiến trình chăm sóc).
  - Nhu cầu, ghi chú nội bộ, lịch sử thay đổi.
  - Các kênh của cùng một người được liên kết với nhau.
- **Việc chăm sóc:** nhắc việc theo khách (gọi lại, gửi báo giá), có hạn và quá hạn.
- **Kênh & agent:**
  - Danh sách tài khoản do các module kênh cung cấp.
  - Gán agent mặc định cho mỗi tài khoản, kèm chế độ AI.
  - Gán riêng theo hội thoại; gán riêng được ưu tiên hơn gán mặc định.
- **Quy tắc:**
  - Giờ nghỉ (mặc định 22:00–07:00).
  - Độ trễ khi tự gửi; từ khoá cần duyệt; trần số câu trả lời; thời gian nhường người thật.
- **Nhật ký CSKH:** mọi lượt agent và lý do (đã trả lời, bỏ qua vì `noise`, vượt hạn mức, giờ nghỉ…).
- **Báo chủ:** việc cần duyệt hiện ở **Cần bạn** trên trang Tổng quan; có thể gửi thêm qua webhook.

**Điểm mở rộng mà `care` cung cấp cho module kênh:**
```ts
interface CareChannel {
  id: 'zalo' | 'gmail' | string; label: string;
  listAccounts(): Promise<ChannelAccount[]>;
  send(ref: ThreadRef, msg: OutboundMessage): Promise<SendResult>;   // kênh tự áp giới hạn của nó
  preflight?(ref, msg): Promise<{ ok: boolean; reason?: string }>;   // ví dụ: giờ nghỉ, nick bị khoá
}
// Kênh đẩy tin đến bằng: ctx.modules.get('care').ingest({ channel, account, thread, message })
```

| Hạng mục | Nội dung |
|---|---|
| Scope | `inbox.read`, `customers.read`, `customers.write`, `reply.draft`, `reply.send` |
| Agent mẫu | `cskh` (context `lean`, Claude Haiku) |
| Skill mẫu | `tra-loi-khach` (giọng điệu, không bịa giá, khi nào chuyển người thật) |
| Bảng | `care_threads`, `care_messages`, `care_customers`, `care_customer_links`, `care_assignments`, `care_drafts`, `care_followups`, `care_rules`, `care_activity` |
| Màn hình | Hộp thư · Nháp chờ duyệt · Khách hàng · Việc chăm sóc · Kênh & agent · Quy tắc · Nhật ký CSKH |
| Widget Tổng quan | "Khách đang chờ", "Nháp chờ duyệt" |
| Cố ý bỏ so với bản gốc | Bộ máy rehearsal, cầu nối legacy và cutover, thẻ cảnh báo Telegram, Telegram MTProto. Lưu ý: `projector`, các test `causal` và hộp thư gửi bền vững vẫn còn trong code; kiểu `telegram` còn trong `care-kit` nhưng AI bị chặn cứng cho kênh đó |

## 2. `zalo`: Zalo

**Mục đích:** kết nối nick Zalo cá nhân, giữ phiên ổn định, chống khoá nick, gửi tin hàng loạt; cấp kênh Zalo cho `care`.

**Kỹ thuật:**
- Dùng thư viện `zca-js` (MIT), chạy trong **tiến trình con riêng do module quản lý** (daemon của bản gốc), giao tiếp với lõi qua HTTP nội bộ có token.
- Lý do tách riêng (giữ từ bản gốc): mỗi nick chỉ giữ được một phiên; khởi động lại AIOS không làm rớt Zalo; `zca-js` có sập cũng không kéo AIOS sập theo.
- Code được **copy nguyên từ bản gốc**, kể cả 12 file có gốc ZaloCRM (danh sách ở `modules/zalo/NOTICE`). Vì vậy **module này mang license AGPL-3.0** (`modules/zalo/LICENSE` và `NOTICE`).
- Agent trả lời khách **chỉ đi qua `care`**. Đường trả lời cũ của Zalo (`responder`, `gate`, `agent-turn`) bị bỏ.

**Tính năng:**
- **Tài khoản:**
  - Thêm nick bằng QR; xem trạng thái; bật/tắt gửi.
  - Lần đầu đăng nhập kéo khoảng 50 tin gần nhất của các nhóm, và lịch sử 1-1 trong phạm vi Zalo cho phép.
  - Đồng bộ nhóm dự phòng 10 phút một lần.
- **Chống khoá nick:** giữ đúng các con số đã chạy ở bản gốc.
  - Trần theo loại thao tác (tin nhắn 1000/ngày với tối đa 20 tin mỗi 30 giây, đọc nhóm, tra cứu người dùng, kết bạn…), sửa được theo từng nick.
  - **Giờ nghỉ 22:00–07:00:** chiến dịch bị hoãn đến sáng; câu trả lời tự động chuyển thành nháp.
  - **Ngân sách marketing:** tối đa 60% trần tin mỗi ngày.
  - **Nuôi nick mới:** tuần 1 tối đa 30 tin/ngày, tuần 2 là 80, tuần 3 là 150.
  - **Tự khoá nick** khi Zalo từ chối 3 lần liên tiếp trên ít nhất 2 hội thoại.
  - Danh sách từ chối nhận tin; trần câu trả lời của agent.
- **Marketing Zalo:**
  - **Mẫu tin:** có nhiều biến thể, chữ định dạng, biến `{ten}`.
  - **Gửi nhóm theo lịch.**
  - **Gửi 1-1 theo danh sách:** chỉ gửi cho người đã từng chat, không nhập số điện thoại.
  - **Chúc mừng sinh nhật.**
- **Xem tin:** tin Zalo hiện trong Hộp thư của `care`. Không có `care` thì module `zalo` chỉ gồm tài khoản, chống khoá nick và marketing.
- **Ảnh khách gửi:** cho agent xem tối đa 4 ảnh gần nhất; trong lượt `lean` ảnh được đưa vào nếu runtime đọc được ảnh.

| Hạng mục | Nội dung |
|---|---|
| Scope | `messages.read`, `broadcast.manage` (gửi trả lời đi qua scope `reply.*` của `care`) |
| Agent mẫu | `zalo-care` (persona trả lời Zalo; trong nhóm chỉ lên tiếng khi có người cần hỗ trợ) |
| Skill mẫu | `zalo-reply` |
| Bảng | `zalo_accounts`, `zalo_threads`, `zalo_messages`, `zalo_usage`, `zalo_settings`, `zalo_templates`, `zalo_group_broadcasts`, `zalo_list_broadcasts`, `zalo_birthdays`, `zalo_optouts` |
| Màn hình | Tài khoản & chống khoá · Tin nhắn · Mẫu tin · Gửi nhóm · Gửi 1-1 · Sinh nhật |
| Bảo mật | Phiên đăng nhập và nội dung tin được mã hoá bằng `AIOS_ENCRYPTION_KEY` |
| Để sau | Proxy riêng cho từng nick, đọc video/thoại/file |
| Lưu ý vận hành | Không mở Zalo Web/PC cho cùng nick khi đang chạy, vì hai bên sẽ đá phiên của nhau |

## 3. `gmail`: Gmail

**Mục đích:** đưa thư Gmail vào hộp thư chung của `care` và trả lời bằng agent.

**Tính năng** (mang từ Sale › Email ở bản gốc):
- Kết nối Gmail qua Composio. Lấy thư 2 phút một lần (không có push).
- Chỉ xét thư đến **sau** lúc bật chăm sóc. Bỏ qua bản tin và thư tự động.
- Trả lời đúng luồng thư, kèm chữ ký. Hiện tại chưa gửi tệp đính kèm.

| Hạng mục | Nội dung |
|---|---|
| Scope | dùng scope của `care` |
| Bảng | `gmail_accounts`, `gmail_sync_state` (thư được lưu vào `care_*`) |
| Màn hình | Tài khoản Gmail (kết nối, bật đồng bộ, chữ ký) |

## 4. `marketing`: Facebook Content Studio

**Mục đích:** soạn, lên lịch và đăng nội dung Facebook Page; phân tích hiệu quả; tự trả lời bình luận.

**Các quyết định giữ nguyên từ bản gốc:**
1. **Media nằm trên máy.** File trong `data/modules/marketing/media/` được tải lên lúc đăng.
2. **App tự đăng đúng phút đã hẹn.** Không dùng lịch hẹn giờ của Facebook.
3. **Reels đăng như video dọc thường.** Composio chưa có công cụ đăng Reels.
4. **Duyệt bài bật theo từng Page** (mặc định bật).
5. **Dashboard mỗi lần chỉ xem một Page.**
6. **Thao tác cần quyền Page dùng token Page.** Xoá bài, đọc bình luận, trả lời, thích, ẩn đều đi qua Graph API với token Page lấy từ danh sách Page quản lý (chỉ giữ trong bộ nhớ). Lý do: đã kiểm chứng thật rằng các tool Composio tương ứng bị lỗi quyền.

**Tính năng:**
- **Pages:** danh sách Page đã kết nối; bật/tắt từng Page; cấu hình duyệt bài; giọng thương hiệu; file FAQ.
- **Kho nội dung:** nháp bài viết, thư viện ảnh/video, khung chat với agent để soạn nội dung (skill `fb-content`).
- **Lịch đăng:** xem theo lịch; bộ đăng chạy mỗi phút; hỗ trợ chữ, ảnh, album, video.
- **Phân tích:**
  - Đồng bộ chỉ số bài đăng. Lượt xem lấy `post_total_media_view_unique` loại lifetime; Reels lấy từ `video_insights`.
  - Agent phân tích phân loại bài và viết tóm tắt.
- **Bình luận AI**, tự trả lời, không cần duyệt:
  - Quy tắc theo Page, ghi đè được theo từng bài. Thứ tự xử lý:
    1. **Spam**: ẩn.
    2. **Phàn nàn**: chuyển người thật và báo ở Cần bạn.
    3. **Từ khoá**: trả lời theo mẫu, xoay vòng nhiều biến thể.
    4. **Agent**: khi bình luận có ít nhất N chữ hoặc có dấu "?".
    5. Còn lại: bỏ qua.
  - Giới hạn: số trả lời mỗi giờ, mỗi người mỗi bài. Không trả lời bình luận cũ có từ trước khi bật.
  - Trả lời riêng qua inbox: chưa thử thật ở bản gốc, sẽ kiểm khi được phép.
  - Nhật ký và màn hình thử quy tắc dùng chung một hàm.

| Hạng mục | Nội dung |
|---|---|
| Cần có | Kết nối Composio, toolkit `facebook` |
| Scope | `content.write`, `publish`, `comments.reply`, `analytics.read` |
| Agent mẫu | `content-fb` (soạn bài), `fb-analyst` (phân tích) |
| Skill mẫu | `fb-content`, `fb-comment-reply` |
| Bảng | 12 bảng `fb_*` giữ nguyên tên của GỐC (trang, nội dung, lịch đăng, chỉ số, bình luận, quy tắc, mẫu, nhật ký, `fb_api_usage`…); xem `modules/marketing/module.json` |
| Hành động cho agent | `content.add`, `content.update`, `content.schedule` (gọi bằng `<aios-action module="marketing" …>`) |
| Màn hình | Pages · Kho nội dung · Lịch đăng · Phân tích · Bình luận AI · Quy tắc bình luận |
| Để sau | Instagram, TikTok, YouTube; bình luận trên bài quảng cáo ẩn (dark post) |
| Thử thật | Chỉ trên Page thử "Ninh Bình Home" (đăng rồi xoá), chỉ khi bạn cho phép |

## 5. `ads`: Quảng cáo Meta (chỉ đọc)

**Mục đích:** theo dõi nhiều tài khoản quảng cáo, chấm điểm bằng quy tắc, và đưa đề xuất. **Không bao giờ sửa gì trên Meta.**

**Tính năng** (mang từ Ads ở bản gốc):
- **Tài khoản quảng cáo:**
  - Lấy danh sách từ các kết nối Meta Ads còn hiệu lực. Kết nối hết hạn thì hiện nút **Kết nối lại**.
  - Mỗi tài khoản có CPA mục tiêu và loại kết quả (lead, tin nhắn, mua hàng, đăng ký).
- **Ảnh chụp mỗi giờ:**
  - Chỉ số theo ngày trong 14 ngày, ở cấp chiến dịch, nhóm quảng cáo và quảng cáo.
  - Chia theo vị trí hiển thị trong 7 ngày; thông tin mẫu quảng cáo.
  - Lượt xem trang đích, lượt xem 3 giây, thruplay.
- **Quy tắc** viết trong code, có test, lý do ghi bằng tiếng Việt kèm số liệu:

  | Quy tắc | Điều kiện | Đề xuất |
  |---|---|---|
  | R1 | Tiêu ≥ 2× CPA mục tiêu mà 0 kết quả | Tắt ngay |
  | R2 | Đã qua giai đoạn học, tiêu ≥ 3× CPA mục tiêu và CPA > 1,5× mục tiêu | Tắt |
  | R3 | Tần suất > 3 và CTR giảm hơn 30% so với 3 ngày đầu | Làm mới mẫu quảng cáo |
  | R4 | CPA < 0,8× mục tiêu 3 ngày liền và ≥ 50 kết quả/tuần | Tăng 20% ngân sách |
  | R5 | Đang trong giai đoạn học | Không đổi gì (trừ khi dính R1) |
  | — | Mẫu quảng cáo có CPA thấp nhất (đủ kết quả) | Nhân bản |

- **Agent đánh giá:** số liệu được tính sẵn trong code; agent chỉ chấm điểm và viết nhận xét trên bảng đã chuẩn bị.
- **Dashboard:**
  - Chỉ số chính so với 7 ngày trước; chi tiêu và CPA trong 14 ngày.
  - Cây chiến dịch → nhóm quảng cáo, kèm đề xuất.
  - Phễu chuyển đổi; mẫu quảng cáo (hook rate, hold rate); vị trí hiển thị.
  - **Bài organic nên chạy quảng cáo**: lấy từ module `marketing` nếu đã Add.
- **Đề xuất** có nút "Đã xử lý" / "Bỏ qua 24 giờ" và liên kết sang Ads Manager.

| Hạng mục | Nội dung |
|---|---|
| Cần có | Kết nối Composio, toolkit `metaads` |
| Scope | `reports.read` |
| Agent mẫu | `ads-analyst` |
| Bảng | `ads_accounts`, `ads_snapshots`, `ads_entities`, `ads_recommendations`, `ads_evaluations` |
| Màn hình | Tổng quan quảng cáo · Chiến dịch · Mẫu quảng cáo · Đề xuất · Cài đặt tài khoản |
| Lưu ý | Ở bản gốc, cả 5 kết nối Meta Ads đều **đã hết hạn**. Cần kết nối lại trước khi thử thật |

## 6. `_template`: khuôn module cho học viên

Tạo bằng `npm run aios -- module new <id>`. Khuôn gồm:
- `module.json`
- một route mẫu
- một migration mẫu
- một worker chạy theo lịch
- một trang có mục menu
- một widget Tổng quan
- một scope
- cách tạo Task cho agent và nhận kết quả trong `onTaskFinished`

Bài tập gợi ý: module "Báo cáo tuần". Mỗi thứ Hai, agent đọc Second Brain và bảng hoạt động đội, viết báo cáo, rồi lưu vào thư mục được phép ghi.
