# Module learn: bài đã đăng thành ghi chú (phần 1, Facebook)

Mỗi bài Facebook đăng qua module `marketing` thành một ghi chú `noi-dung/bai/<ngày>-<slug>.md` (`loai: bai-dang`) trong thư mục Second Brain chọn ở cài đặt `folder`. Từ các ghi chú đó, trang **Phân tích nội dung** tính dạng bài nào hiệu quả.

## Bật và tắt

- Cần `marketing` đã bật. **Add** tạo hai bảng `learn_state` (con trỏ của luồng nội dung, thư mục đã ghi bù) và `learn_post_index` (bài nào ở ghi chú nào, khoá `(folder_id, source, source_id)`).
- Cài đặt `folder` để trống thì module **không đọc, không ghi gì**, con trỏ đứng yên; `GET /api/m/learn/status` và trang Phân tích nội dung báo `no-folder` và cho chọn thư mục. Thư mục đã chọn mà không còn thì báo `folder-missing`; `marketing` tắt thì `no-marketing`.
- Lần đầu ghi vào một thư mục: tạo ghi chú cho các bài đăng trong 90 ngày gần nhất, mỗi lô 100 bài một commit (`notes.batch`).
- **Remove** dừng bộ đọc; con trỏ giữ trong bảng nên lần **Add** sau đọc bù từ chỗ dừng. **Purge** xoá hai bảng (không xoá ghi chú).

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

Nhóm Marketing › **Phân tích nội dung** (`/m/learn`, bản vẽ `ContentLab.dc.html`) và trang một bài (`/m/learn/posts/:path`, `ContentNote.dc.html`). Chưa có lời "bot giải thích vì sao" và phần sổ bài học (việc của T15).

## Kiểm thử

`npx vitest run modules/learn` (feed giả + dịch vụ ghi chú thật trên thư mục tạm; một test đi qua module manager với `marketing` thật).
