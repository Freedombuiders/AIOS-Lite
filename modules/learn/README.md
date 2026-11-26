# Module learn: bài đã đăng thành ghi chú, sổ bài học, tổng kết tuần

Mỗi bài Facebook đăng qua module `marketing` thành một ghi chú `noi-dung/bai/<ngày>-<slug>.md` (`loai: bai-dang`) trong thư mục Second Brain chọn ở cài đặt `folder`. Từ các ghi chú đó, trang **Phân tích nội dung** tính dạng bài nào hiệu quả.

## Bật và tắt

- Cần `marketing` đã bật. **Add** tạo các bảng `learn_state` (con trỏ của luồng nội dung, thư mục đã ghi bù), `learn_post_index` (bài nào ở ghi chú nào, khoá `(folder_id, source, source_id)`), và từ phần 2: `learn_weekly` (tuần nào đã viết tổng kết), `learn_lesson_log` (mỗi lần bài học đổi trạng thái), `learn_proposals` (mục Chờ duyệt), `learn_hook_cache` (kiểu mở đầu theo băm nội dung).
- Cài đặt `folder` để trống thì module **không đọc, không ghi gì**, con trỏ đứng yên; `GET /api/m/learn/status` và trang Phân tích nội dung báo `no-folder` và cho chọn thư mục. Thư mục đã chọn mà không còn thì báo `folder-missing`; `marketing` tắt thì `no-marketing`.
- Lần đầu ghi vào một thư mục: tạo ghi chú cho các bài đăng trong 90 ngày gần nhất, mỗi lô 100 bài một commit (`notes.batch`).
- **Remove** dừng bộ đọc; con trỏ giữ trong bảng nên lần **Add** sau đọc bù từ chỗ dừng. **Purge** xoá các bảng (không xoá ghi chú).

## Đọc từ marketing

Chỉ qua `ctx.modules.get('marketing').contentFeed` (hợp đồng `modules/_lib/content-feed.ts`), không dùng `ctx.events`: SDK thêm tiền tố id module của bên nghe, và sự kiện trong bộ nhớ mất khi khởi động lại.

- Lúc khởi động đọc bù từ con trỏ đã lưu, sau đó cứ 5 giây đọc phần mới. Con trỏ lưu sau mỗi trang 100 sự kiện.
- Một sự kiện chỉ cho biết bài nào đổi. Ghi chú được dựng lại từ dòng hiện tại (`contentFeed.get`), nên đọc lại luồng hay dừng giữa chừng không tạo bản thứ hai. Không thấy ghi chú ở đường dẫn đã lưu (chủ đổi tên, chuyển chỗ) thì tìm theo `id` trong `noi-dung/bai/` trước khi tạo mới.
- Chỉ bài đăng qua Kho nội dung (`origin = studio`), trạng thái `published`. Bài bộ phân tích nhập từ Page bỏ qua.

## Ghi chú

Khoá viết **lúc tạo** (sau đó là của chủ, máy không ghi lại): `id`, `nen_tang: facebook`, `tieu_de`, `dinh_dang` (reel → `video-ngan`, video → `video`, photo → `anh`, album, text → `chu`, link → `lien-ket`), `tru_cot` (trụ cột của bài trong Kho), `mo_dau` (kiểu hook của Kho nếu trùng một giá trị của schema: câu hỏi, con số, kể chuyện → `cau-chuyen`…), `kieu_hook` (kiểu hook nguyên văn), `so_chu`, `dang_luc`, `ma_bai`, `link`, và dòng dõi: `de_xuat`, `cong_thuc`, `cong_thuc_phien_ban`, `hoc_tu`, `ky_vong`. Không có bước gắn nhãn bằng AI.

Khoá máy cập nhật mỗi lần có số đo: `so_do` (mỗi mốc một mục `{ moc, luc_do, reach, er, tb_xem, hien_thi, cam_xuc, binh_luan, chia_se, click, xem_3s, theo_doi, luu }`, chỉ những số Facebook thật sự trả; thiếu thì bỏ khoá, không ghi 0), `moc_da_do`. Một mốc mới không ghi đè mốc khác; khoá chủ thêm vào một mục được giữ. `do_dai` (giây, video), `link`, `ma_bai` chỉ được điền khi còn trống. ER lấy từ `marketing` (`erOf`, trả kèm mỗi số đo trong `contentFeed.get`), không tính lại.

Phần thân ngoài khối máy quản lý `<!-- aios:begin so-do -->…<!-- aios:end so-do -->` (bảng các mốc) là của chủ và giữ nguyên từng byte.

## Thống kê (`server/stats.ts`, hàm thuần)

ER trung vị theo `dinh_dang × tru_cot`, theo kiểu mở đầu (`mo_dau`, không có thì `kieu_hook`), theo khoảng độ dài (video theo giây, bài khác theo số chữ), mỗi ô kèm số bài. Chỉ so các bài cùng nền tảng và **cùng một mốc** (mặc định 24 giờ, chọn được 1h…28d; `latest` không dùng để so). Ô dưới 3 bài đã đo gắn `lowSample` ("ít mẫu"), ô chưa có bài `notTried` ("chưa thử"), có bài mà chưa đo ở mốc đó `unmeasured`. Khi so một bài với các bài khác, bài đó không nằm trong trung vị.

## API

| Đường | Trả |
|---|---|
| `GET /api/m/learn/status` | trạng thái bộ đọc, thư mục, con trỏ, số ghi chú |
| `POST /api/m/learn/sync` | chạy một lượt ngay |
| `GET /api/m/learn/content-lab?days=90&moc=24h` | `{ status, dir, mocs, stats }` (stats `null` khi chưa có thư mục) |
| `GET /api/m/learn/posts/:path` | ghi chú `noi-dung/bai/…` kèm so sánh ở một mốc (`?moc=`) |

## Màn hình

Nhóm Marketing › **Phân tích nội dung** (`/m/learn`, bản vẽ `ContentLab.dc.html`) và trang một bài (`/m/learn/posts/:path`, `ContentNote.dc.html`). Chưa có lời "bot giải thích vì sao".

Nhóm Marketing › **Vòng học** (phần 2), bốn tab: Tổng quan (`/m/learn/loop`, `Loop.dc.html`), Sổ bài học (`/m/learn/playbook`, `Playbook.dc.html`), Chờ duyệt (`/m/learn/pending`, `Learn.dc.html`), Tổng kết tuần (`/m/learn/weekly[/:năm/:tuần]`, `Weekly.dc.html`). Trong màn soạn bài của Kho nội dung có ô **Khớp sổ bài học x/y** (web `provides['marketing.composerScore']`, `marketing` render qua `useProvides`).

## Phần 2: sổ bài học, tổng kết tuần, chấm trước khi đăng (T15)

### Sổ bài học (`server/playbook.ts`)

Ghi chú `loai: bai-hoc` trong `bai-hoc/`: `tieu_de`, `mang` (noi-dung, cham-khach, quang-cao), `trang_thai`, `nen_tang` (mặc định facebook), `bang_chung` (liên kết `[[ghi-chu-bai]]`), `bai_thu` (liên kết bài cố ý làm theo), `dung_boi` (id agent được dùng), và tuỳ chọn `ap_dung` để máy kiểm được:

```yaml
ap_dung:
  dinh_dang: [video-ngan]   # định dạng
  gio_dang: "19-21"          # khung giờ đăng, giờ của Page
  thu: [3, 5]                # thứ Ba, thứ Năm (2…7, cn)
  do_dai_toi_da: 45          # giây với video, chữ với bài khác
  do_dai_toi_thieu: 10
  mo_dau: cau-hoi            # kiểu mở đầu (agent nhận, xem dưới)
```

Mọi chuyển trạng thái đi qua **một** hàm `transition(ref, to, principal)`. `principal` là `Principal` của dịch vụ ghi chú, do đường gọi cấp chứ không lấy từ payload: đường HTTP là `owner`, máy là `module:learn`, action là `agent:<id>`.

| Bước | Ai | Điều kiện |
|---|---|---|
| gia-thuyet → dang-thu | máy (tự) hoặc chủ | ≥ 3 bằng chứng **còn tồn tại**: liên kết tới ghi chú `bai-dang` có thật, cùng nền tảng. Máy chuyển thì nêu mục cần chú ý. |
| dang-thu → da-kiem-chung | **chỉ chủ** | máy đề xuất (Chờ duyệt) khi đủ `trial_posts` bài thử đã đo (mặc định 4) và ER trung vị của chúng cao hơn trung vị kênh |
| dang-thu → bi-bac-bo | chủ | máy đề xuất khi đủ bài thử mà không cao hơn |
| da-kiem-chung → dang-thu | máy (tự) hoặc chủ | 5 bài gần nhất làm theo đều dưới trung vị kênh |
| gia-thuyet / da-kiem-chung → bi-bac-bo, bi-bac-bo → gia-thuyet | chủ | |

Agent không đi được bước nào (bị từ chối trước khi đọc ghi chú); module khác cũng không. Bài thử = `bai_thu` cộng (khi có `ap_dung`) các bài đăng từ lúc bắt đầu thử mà khớp mọi quy tắc. So sánh luôn ở cùng nền tảng và cùng mốc (cài đặt `moc`, mặc định 24 giờ); bài đang được chấm không nằm trong trung vị so với nó. 3–4 bài gắn nhãn "thăm dò", không bao giờ "đã chứng minh". Đề xuất chủ đã bỏ chỉ quay lại khi có thêm bài đã đo.

`da-kiem-chung` chỉ được tin (đưa cho agent, dùng để chấm) khi lần đổi gần nhất trong `learn_lesson_log` là của chủ. Ghi tay trong Obsidian, hay agent ghi thẳng vào file, thì phải bấm "Xác nhận đã kiểm chứng" trong app.

Máy xét sổ lúc khởi động và 5 phút một lần (nút "Xét lại ngay" trên trang).

### Agent đề xuất

ModuleAction `learn:propose` (scope `learn.propose`): tạo một ghi chú `gia-thuyet` với `de_xuat_boi`, `dung_boi: []`, và một mục ở Chờ duyệt. `trang_thai` hay `dung_boi` trong payload bị bỏ qua. Không action nào đổi trạng thái. Chủ "Bỏ" thì bài học sang `bi-bac-bo` để không bị đề xuất lại.

### Bài học trong ngữ cảnh agent

`agentContext` chèn bài học khi agent có scope `playbook.read` của `learn` **và** có tên trong `dung_boi`, chỉ bài `da-kiem-chung` chủ đã duyệt, tối đa 10 bài và 1.500 ký tự, bọc bằng `untrusted()` (export từ `src/shared/context.ts`, SDK re-export). Bọc chỉ là nhãn cho model, không phải rào quyền.

### Hai thước đo (`server/metrics.ts`)

Theo tuần ISO (thứ Hai đến Chủ nhật, giờ Việt Nam): ER trung vị các bài Facebook đăng trong tuần ở mốc `moc`, và tỷ lệ nháp gửi nguyên lấy qua `care.draftStats` (đếm nháp bot soạn, `payload_revision = 1`, đã gửi thật; mẫu số gồm cả nháp bị sửa và bị bỏ). `learn` không đọc bảng của `care`.

### Tổng kết tuần (`server/weekly.ts`)

`ctx.schedule.every('weekly', '30 7 * * 1', …)` viết `tong-ket/<năm>-tuan-<số>.md` cho tuần vừa xong. Lúc khởi động (và mỗi 5 phút) kiểm `learn_weekly` và viết bù nếu thiếu: hẹn giờ không chạy bù khi máy tắt. Một tuần chỉ được viết một lần (khoá `(year, week)`, gộp các lần gọi trùng lúc, ghi chú có sẵn mà chưa có dòng thì chỉ ghi dòng). Code tính số liệu; một lượt `lean` của agent ở cài đặt `agent` (cần `playbook.read`) viết "Cái được", "Cái hỏng" và thêm đề xuất; không có agent thì vẫn có phần số. "Đề xuất tuần này" là danh sách có ô đánh dấu (khối `de-xuat`, kèm `de_xuat` trong frontmatter). `POST /api/m/learn/weekly/:năm/:tuần/approve` (chỉ chủ) nhận các dòng được chọn, đánh dấu `da_duyet` trước rồi tạo việc qua `ctx.tasks.create`; duyệt lần hai bị từ chối.

### Chấm trước khi đăng (`server/score-draft.ts`)

`POST /api/m/learn/score-draft` `{ text, format, scheduledAt, hasVideo, videoLengthS?, hook? }`. Giờ đăng, định dạng, độ dài kiểm bằng code so với các bài `da-kiem-chung` (mảng nội dung) có `ap_dung`. Kiểu mở đầu dùng một lượt `lean`, nhớ theo băm nội dung (`learn_hook_cache`); cùng nội dung chỉ tốn một lượt, kể cả hai yêu cầu cùng lúc. `hook: false` (màn soạn bài gọi khi đang gõ) không chạy agent; bấm "Chấm cả kiểu mở đầu" mới chạy. Trả `matched`/`checkable` cho ô "Khớp sổ bài học x/y".

### API phần 2

| Đường | Làm gì |
|---|---|
| `GET /loop` | số liệu trang Tổng quan (8 tuần, đếm bài học, đổi trạng thái 7 ngày, đang thử) |
| `GET /playbook`, `POST /playbook` | sổ bài học; chủ thêm giả thuyết |
| `POST /playbook/transition` `{ path, to }` | chủ đổi trạng thái (qua `transition`) |
| `POST /playbook/evaluate` | máy xét ngay |
| `GET /pending`, `POST /pending/:id/accept`, `/dismiss` | Chờ duyệt |
| `GET /weekly`, `GET /weekly/:năm/:tuần`, `POST /weekly/run` | tổng kết; viết bù tuần trước |
| `POST /weekly/:năm/:tuần/approve` `{ lines }` | chủ duyệt kế hoạch, tạo việc |
| `POST /score-draft` | chấm bài nháp |

## Cho module khác (D2)

- **Luồng ghi chú** `provides.postNotes.events(cursor, limit)`: mỗi lần một ghi chú `bai-dang` có thêm mốc đo, hoặc ER của một mốc đổi, ghi một dòng vào `learn_note_events` (migration `003_note_events.sql`) ngay sau khi ghi file. Bên đọc tự giữ con trỏ (dream giữ trong `dream_state`) và đọc bù lúc khởi động. Ghi sự kiện lỗi thì chỉ log, không làm hỏng ghi chú đã ghi; bên đọc tự đối chiếu bù từ ghi chú.
- **Module đề xuất bài học** `provides.playbook.proposeFromModule(moduleId, payload)`: cùng đường với `learn:propose` của agent, nhưng ký `module:<id>` (`de_xuat_boi`, `proposed_by`). Luôn vào `gia-thuyet` và nằm ở Chờ duyệt. Dream gọi khi một công thức chuyển sang `hop`.

## Kiểm thử

`npx vitest run modules/learn` (feed giả + dịch vụ ghi chú thật trên thư mục tạm; hai test đi qua module manager với `marketing` thật). Phần 2: `playbook.test.ts` (gồm test bắt buộc: agent chuyển sang `da-kiem-chung` bị từ chối), `weekly.test.ts`, `score-draft.test.ts`, `web/pages/loop.test.tsx`.
