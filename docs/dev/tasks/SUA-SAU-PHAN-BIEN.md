# Sửa các task sau khi có bản phản biện

> 26/11/2026 · Dựa trên [OPEN-AGENTICOS-PLAN.PHAN-BIEN.md](../OPEN-AGENTICOS-PLAN.PHAN-BIEN.md) (Codex `gpt-6-astra`, kiểm tĩnh, không chạy app hay test).
> **File này thắng các file task và bản kế hoạch ở những chỗ mâu thuẫn.** Ai nhận một task phải đọc mục của task đó ở đây trước.

## 1. Ba điều bản kế hoạch nói sai, ảnh hưởng mọi task

1. **"Bot không tự gửi, đăng, chi tiền" hiện chưa đúng trong code.**
   - `care` ở chế độ `auto` tự gửi tin.
   - Agent marketing có scope ghi nội dung thì tự duyệt được bài khi trang đặt `approval_required = 0` (`modules/marketing/server/core/agent-commands.ts:227-248`). Cờ này nằm ở `fb_pages`, không phải ở từng bài.
   - API lõi mặc định không đòi mã (`src/api/server.ts:60-67`, `src/core/config.ts:71-75`), nên một agent có shell gọi được mọi đường HTTP ở `localhost`. "Chỉ có đường HTTP, không đăng ký thành action" **không phải** rào an toàn.
   - Quy ước từ nay: bản đầu mặc định là **chỉ soạn nháp**. Chế độ tự làm là lựa chọn chủ bật có chủ đích, từng kênh một.
2. **`untrusted()` chỉ là một hàm nội bộ tạo chuỗi** (`src/shared/context.ts:32-35`, không export). Nó không chặn được gì. Task nào cần bọc dữ liệu thì export hàm đó (việc của T01 hoặc task đầu tiên cần tới), và không coi việc bọc là một rào quyền.
3. **Sự kiện giữa các module không nghe chéo được như kế hoạch viết.** SDK tự thêm tiền tố id module vào tên sự kiện, cả lúc phát lẫn lúc nghe (`src/modules/context.ts:37, :165-170`). `learn` gọi `ctx.events.on('metrics.snapshot')` sẽ nghe `learn:metrics.snapshot`, không phải của `marketing`. Module cần báo cho module khác thì cung cấp một hàm đăng ký qua `provides`, có con trỏ để đọc bù khi khởi động.

## 2. Đổi phạm vi và thứ tự

| Task | Quyết định | Lý do |
|---|---|---|
| T01, T02 | Giữ, có sửa (đã gửi cho worker đang làm) | Phát hiện 14 |
| T03, T04 | Giữ, có sửa lớn (đã gửi cho worker đang làm) | Phát hiện 1, 6, 7 |
| T05 | Giữ, có sửa | Phát hiện 13 |
| T06 | Giữ, **viết lại hai phần** | Phát hiện 8, 13 |
| T07 | Giữ | — |
| T08 | **Chỉ làm một chiều: SQLite ra ghi chú** | Phát hiện 4, 5 |
| T09 | **Đề xuất hoãn** xếp hạng và chân dung; giữ bốn màn đọc | Phát hiện 4; chưa có dữ liệu đơn hàng |
| T10 | Giữ | — |
| T11 | **Đề xuất hoãn** | Không cần để kiểm giá trị sản phẩm |
| T12 | **Thu về Facebook** cho bản đầu | Phát hiện 11 |
| T13 | **Đề xuất hoãn** toàn bộ phần ghi lên Meta | Phát hiện 3 |
| T14, T15 | Giữ, nhưng **cần một task mới chạy trước** (T14a, mục 4) | Phát hiện 9, 10 |
| T16 đến T18 | **Đề xuất thu nhỏ** bản đầu: thêm link tay hoặc RSS, không quét Apify hằng ngày | Phát hiện 12, 15 |
| T19 đến T25 | Chưa được phản biện (viết sau) | — |
| T26 | **Đề xuất hoãn** | — |
| T27 | Giữ; một phần phải làm **sớm**, không để cuối | Phát hiện 16 |

Các dòng "đề xuất hoãn" chờ chủ dự án quyết. Không khởi động worker cho chúng khi chưa có trả lời.

Lát cắt đầu tiên nên chạy được trọn vẹn trước khi mở rộng: **GenBot chỉ chữ → `care` soạn nháp → chủ duyệt → gửi đúng một lần**, có tạm dừng và tiếp quản đúng, marketing Zalo tắt ở mọi chỗ.

## 3. Sửa theo từng task

### T05 · Zalo chỉ còn chat

- Daemon khởi động bằng biến môi trường riêng **trước** khi lõi đẩy cấu hình (`modules/zalo/server/daemon.ts:87, :121-134`). Đổi mặc định trong `module.json` chưa đủ: phải đổi mặc định ở cả chỗ daemon tự đọc, và kiểm các hàng chờ gửi marketing còn sót khi chuyển sang tắt.
- Mã giấy phép đúng là `AGPL-3.0-only` (`modules/zalo/NOTICE:3-13`), không phải `AGPL-3.0`.
- `modules/zalo/server/index.ts:121-127` gọi `runLean` cho biến thể mẫu tin marketing. Khi marketing tắt, đường này không được chạy.

### T06 · Care chạy trên GenBot

Sai trong file task, sửa như sau:

- **Scope:** agent cần `reply.draft` mới tạo được nháp; `reply.send` chỉ thêm quyền tự gửi (`agent-turn.ts:318-319, :603-605`).
- **Chế độ:** bảng gán dùng `observe | draft | auto`; đường `/conversations/:id/ai` nhận `off | draft | auto` (`routes-workflow.ts:27, :79-83`). Hai bộ giá trị khác nhau.
- **Trần 30:** là theo từng cuộc chat mỗi ngày (`maxRepliesPerThreadDay`), không theo khách.
- **"Chỉ trả lời tin chữ" chưa đúng:** cổng hiện cho qua ảnh không kèm chữ (`policy/message-gates.ts:135-144`), và `care` chuyển ảnh, PDF theo khả năng của runtime. Với agent chạy GenBot, tin chỉ có ảnh hoặc PDF phải chuyển cho chủ, không lặng lẽ bỏ phần ảnh.
- **Ngữ cảnh:** đã có trần 6.000 token ước lượng, và tin kích hoạt cũng bị rút ngắn khi cần (`agent-context.ts:32-39, :212-230`). Vấn đề thật là tổng prompt: ngân sách `lean` của lõi đã là 23.500 ký tự trước phần việc. Phần này T03 xử lý ở bộ dựng ngữ cảnh; T06 chỉ kiểm lại với `care`.
- **Gom tin 3–12 giây không tồn tại.** Con số đó là độ trễ trước khi tự gửi, sau khi model đã chạy. Mỗi tin của khách xếp một việc riêng (`ingest.ts:486-498`). Nếu muốn gom tin để đỡ tốn lượt gọi GenBot (10 lượt mỗi phút), phải viết thêm: trì hoãn việc `inbound_turn` vài giây và gộp theo cuộc chat.

**Luật đòi gặp người, viết lại hoàn toàn:**

- `eligibility.ts` là hàm quyết định thuần, không phải chỗ ghi cơ sở dữ liệu. `maybeEnqueueTurn` cũng không gọi nó (`ingest.ts:445-500`).
- Đặt việc kiểm ở `ingest`, với tin trực tiếp, chiều vào, của khách: trong **cùng giao dịch** lưu tin, ghi trạng thái chuyển giao, đặt cả `is_paused = 1` lẫn `paused_until` (code đòi cả hai, `eligibility.ts:255-270`), rồi mới quyết định có xếp việc không.
- Huỷ hoặc chuyển sang chờ xem lại mọi `care_delivery_intents` do bot tạo đang chờ của cuộc chat đó. Nếu chỉ hoãn, hết 60 phút hệ thống sẽ gửi một câu trả lời đã lỗi thời.
- Lượt agent đang chạy dở: kết quả của nó bị bỏ ở bước kiểm lại sau khi chạy (`agent-turn.ts:401-422`).
- Chỉ chủ gỡ được trạng thái chuyển giao. Dùng lại cơ chế tiếp quản và tắt AI sẵn có, đừng dựng hệ trạng thái thứ ba.
- Chưa có API đặt `is_paused`, `paused_until`. Cái sẵn có là hoãn việc (`snooze`), tắt AI, tiếp quản; chúng không tương đương tạm dừng có hạn.

**Gửi ảnh khi tự nhắn: bỏ khỏi task này.** Đường của `care` chỉ gọi `sendMessage` với chữ, và hàng chờ gửi không có hợp đồng cho tệp. Làm đúng cần tải lên, kiểm, băm, biên nhận và gửi lại cho từng tệp. Thành một task riêng về sau. Không chép `sender.ts` (AGPL) sang `care`.

### T08 · Khách hàng thành ghi chú

Chỉ làm **SQLite ra ghi chú**. Bỏ chiều ngược lại, bỏ bảng xung đột.

- `crm_note_index` không lưu giá trị gốc từng trường, nên không biết được trường nào đổi ở bên nào. "File thắng" sẽ đưa một khách từ `won` về `consulting` chỉ vì chủ sửa một câu trong phần thân.
- Hồ sơ và việc cần làm có `revision` riêng; một `db_revision` của khách không theo dõi được chúng.
- `care_customers` không có `nguon`, `gia_tri`, `viec_tiep`, `han`. Các khoá này lấy từ `care_profiles` và `care_tasks`, hoặc để trống.
- Phần thân ngoài các khối máy quản lý là của chủ, máy không đụng. Đây là chỗ chủ ghi chú tự do trong Obsidian.
- Khoá của chỉ mục là `(folder_id, rel_path)`. Hai công ty có thể cùng có `khach-hang/lan.md`.
- `listCustomers` trả tối đa 500 và không có con trỏ (`directory-stores.ts:110-116`). Thêm phân trang trước khi dùng cho lần xuất đầu.
- `provides` của `care` hiện chỉ có `careChannels` (`modules/care/server/index.ts:30-34`).
- Lịch sử git và ghi chú giữ tên, số điện thoại ở dạng chữ thường lâu dài. Ghi rõ điều này trong tài liệu người dùng; việc xoá một khách phải xoá cả file.

### T12 · Module `social`

Bản đầu chỉ Facebook, đọc từ phân tích sẵn có của `marketing`. Phần đọc số liệu của `kol` chỉ đo các bài mà chính `kol` đã đăng, trong 30 ngày, có mã bài ngoài (`modules/kol/server/metrics.ts:193-198`). Tách các hàm Composio ra không tạo được danh sách video của tài khoản. Muốn YouTube, Instagram, TikTok thì phải tách cả tài khoản, đăng bài và ánh xạ mã bài khỏi `kol` trước; đó là một task riêng.

### T14, T15, T18 · Vòng học và công thức

Xem mục 4 (task mới T14a phải xong trước). Thêm:

- `fb_content` đã có `pillar` và `hook_type`. Dùng lại, đừng gắn nhãn lại từ đầu. Bộ phân loại và phân tích sẵn có nằm ở `marketing/server/analytics/analyst.ts:291-299`.
- Mỗi lần đo là một dòng riêng theo mốc; ghi chú giữ một danh sách `so_do`, không ghi đè `reach`, `er`. So bài mới ở mốc 24 giờ với bài cũ ở mốc 7 ngày là so lệch.
- Kỳ vọng của một lần thử được **cố định lúc tạo đề xuất** và lưu cùng phiên bản công thức. Bài đang được chấm không nằm trong nhóm làm kỳ vọng cho chính nó.
- So sánh chỉ trong cùng nền tảng và cùng mốc. YouTube không có reach, nên không có ER theo reach; giữ "không biết", không điền số.
- Ba hay bốn bài chỉ đủ cho nhãn "thăm dò". Giao diện không được nói công thức "làm tăng" hiệu quả.
- Agent chỉ nhận bài học qua `agentContext` khi có scope của module `learn` (`src/work/engine.ts:82-89`). Có tên trong `dung_boi` chưa đủ.
- Tỷ lệ "nháp gửi nguyên": `payload_revision` bằng `approved_revision` chỉ nói rằng bản hiện tại đã được duyệt, không nói là chưa sửa (`outbox-store.ts:448-466, :517-519, :575-576`). Đếm nháp do bot tạo, có `payload_revision = 1`, và đã gửi thật; mẫu số gồm cả nháp bị sửa và bị bỏ.

### T16 đến T18 · Dream 100

- Lấy 10 video mới nhất mỗi ngày nhưng tính trung vị trên 30 video thì các video cũ bị đóng băng ở số xem lúc mới đăng, làm trung vị thấp giả. Phải làm mới số đo theo cùng độ tuổi video, lưu `captured_at` và tuổi video cho mỗi lần đo.
- Trần chi Apify trong kế hoạch là **kiểm sau**: actor chạy xong mới biết tốn bao nhiêu, thiếu số thì coi là 0, và hết giờ chờ không dừng actor (`modules/radar/server/collectors/apify.ts:179-209`). Cần giữ chỗ ngân sách trước khi chạy, lưu mã lượt chạy ngay, đối soát lượt dở, và dùng chung một sổ chi giữa Radar và Dream.
- Con số "2 đến 6 USD mỗi 1.000 kết quả" là lời mô tả trong code, chưa ai kiểm. Không dùng làm báo giá.
- Bảng cần cột đếm số ngày lỗi liên tiếp, và ràng buộc duy nhất theo ngày cho lượt chạy.
- Tách bộ thu thập khỏi Radar phải mang theo cả phần phụ thuộc (ngữ cảnh, kiểu, kho khoá, trình duyệt), không chỉ bốn file (`collectors/sources.ts:3-9`).
- Bốn khung hình của 3 giây đầu không đủ để nói về cấu trúc cả video. Video không có phụ đề tự động thì gần như không có căn cứ để gắn nhãn; ghi rõ "thiếu dữ liệu" thay vì đoán.
- Đề xuất cho bản đầu: chủ dán link video muốn học, máy đo và mổ xẻ từng cái theo yêu cầu, rồi đề xuất. Quét tự động 100 kênh là bước sau.

### T27 · Dọn để mở nguồn

- Bản kế hoạch nói các module "port từ `freedom_os` thương mại". Hồ sơ trong repo phân biệt rõ: phần được mang sang là code chủ dự án tự viết trong bản riêng, không phải code của bên trên (`THIRD_PARTY_NOTICES.md:62-72`, `modules/*/PORTING.md:3`). Dùng đúng cách nói này. Lời tự khai trong repo vẫn chưa phải xác nhận quyền, nên việc chủ dự án xác nhận vẫn cần.
- `scripts/check-provenance.mjs` chỉ tìm các đoạn 8 dòng đã chuẩn hoá và có danh sách loại trừ. Chạy qua không chứng minh code sạch.
- `THIRD_PARTY_NOTICES.md` còn liệt kê Paperclip, OpenFilm, FireRed, open-edit, video-use. Không làm mất khi đóng gói.
- **Làm sớm, không để cuối:** lập danh mục nguồn và ranh giới module trước khi bất kỳ task nào chuyển code giữa các module (T12, T16, T17 đều chuyển code). Code AGPL của Zalo không được chép sang lõi hay sang `care`.

## 4. Task mới: T14a · Dòng dõi của một bài đăng

> Nhánh Marketing · 2 ngày · Phải xong trước T14, T15, T18

**Vì sao:** vòng "đề xuất → bài → số đo → công thức" hiện đứt ở ba chỗ.

1. `fb_content.id` là số nguyên, bảng không có cột `meta`, và hàm ghi chỉ nhận danh sách cột cho trước (`modules/marketing/server/store.ts:193-215`). `meta.cong_thuc` sẽ biến mất ngay khi chèn.
2. Bộ đăng bài không phát sự kiện khi đăng xong (`core/publisher.ts:252-273`); bộ phân tích ghi số đo cũng không (`analytics/sync.ts:454`, `store.ts:877-888`).
3. Khi bộ phân tích nhập về một bài trước lúc bộ đăng bài kịp lưu `fb_post_id`, bộ đăng bài gặp lỗi trùng và để dòng gốc với `fb_post_id = null`. Số đo khi đó gắn vào dòng được nhập, là dòng không mang công thức (`store.ts:830-855, :892-895`).

**Việc phải làm:**

- [ ] Migration thêm vào `fb_content` các cột: `idea_id`, `formula_slug`, `formula_version`, `source_video_slug`, `expected_ratio` (kỳ vọng cố định lúc tạo). Cập nhật kiểu, DTO, danh sách cột của hàm ghi, đường nhân bản, đường duyệt.
- [ ] Sửa chỗ đối soát giữa bài tự đăng và bài nhập về: khi thấy cùng mã bài của Facebook, gộp về **dòng gốc** (dòng mang dòng dõi), không để hai dòng.
- [ ] `marketing` cung cấp qua `provides` một dịch vụ `contentFeed`: `since(cursor)` trả các sự kiện `published` và `snapshot` theo thứ tự, kèm con trỏ. Module khác tự giữ con trỏ và đọc bù lúc khởi động. Không dựa vào bus sự kiện trong bộ nhớ.
- [ ] Test đi hết chuỗi: tạo bài có dòng dõi, đăng bằng Composio giả, cho bộ phân tích nhập về **trước** khi bộ đăng bài lưu mã, rồi kiểm chỉ còn một dòng và dòng đó còn dòng dõi lẫn số đo.

**Xong khi:** test chuỗi trên xanh; `npx vitest run modules/marketing` qua mà không sửa test cũ nào.

## 5. Việc phải có trước khi coi lát cắt đầu là an toàn

Những việc này chưa nằm trong task nào. Đưa vào T04 hoặc tách task riêng trước khi mời người dùng thật.

- [ ] **Xác thực chủ ở API lõi.** Đường nào gửi tin, đăng bài, hay tiêu tiền phải đòi một danh tính chủ mà tiến trình agent không có. Hiện API không đòi mã theo mặc định.
- [ ] **Một chính sách tự động duy nhất**, kiểm ở chỗ tạo, duyệt và gửi: bản đầu chỉ nháp. Việc duyệt gắn với đúng nội dung, đúng đích, đúng phiên bản.
- [ ] **Bài marketing:** không cho agent tự duyệt bài, kể cả khi trang tắt `approval_required`.
- [ ] **Mỗi công ty một bot GenBot.** Bộ nhớ và chỉ dẫn thường trực của bot GenBot nằm ngoài bộ lọc quyền brain của AIOS, nên dùng chung một bot cho hai công ty là trộn dữ liệu.

## 6. Những gì bản phản biện chưa kiểm được

- Trường trạng thái kết bạn của `zca-js` 2.1.2: không có mã nguồn thư viện trong máy lúc kiểm.
- Giấy phép hiện hành của `javis-os` và `freedom_os`: không dùng mạng.
- Toàn bộ nhánh Cloud và Mobile (T19 đến T25): viết sau khi giao phản biện.
- Không chạy app, test, hay `check-provenance`. Mọi kết luận là từ đọc code.
