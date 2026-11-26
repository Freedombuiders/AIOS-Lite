# T08 · Module `crm` 1: khách hàng thành ghi chú

> Nhánh Chăm khách · 3 ngày · Phụ thuộc: T02 · Kế hoạch mục 5.3.1 đến 5.3.3

## Mục tiêu

Mỗi khách trong `care` có một ghi chú `khach-hang/<slug>.md`. Sửa ở app hay ở Obsidian đều tới được bên kia, không mất dữ liệu khi hai bên cùng sửa.

## Quyết định cần xác nhận

Câu hỏi Q3 và Q4 của kế hoạch. Task này làm theo đề xuất: đồng bộ hai chiều, file thắng với trường kinh doanh, và chấp nhận tên, số điện thoại ở dạng chữ thường trong file. **Nếu bản phản biện khuyên làm một chiều trước thì làm bước "Từ SQLite ra file" và dừng**, phần còn lại thành task sau.

## File đụng tới

| File | Loại |
|---|---|
| `modules/crm/` (module mới: `module.json`, `migrations/001_init.sql`, `server/index.ts`, `server/sync.ts`, `server/slug.ts`) | MỚI |
| `modules/care/server/index.ts` | SỬA: `provides` thêm dịch vụ `customers`; phát sự kiện `customer.changed` |
| `modules/care/server/persistence/…` (kho khách hàng) | SỬA: gọi phát sự kiện sau mỗi lần ghi |

## Các bước

- [ ] Đọc `modules/care/server/index.ts` xem `provides` đang trả gì. Thêm `customers: { list(), get(id), update(id, patch, expectRevision), create(input) }`. Dịch vụ này giải mã các cột `*_enc` trước khi trả.
- [ ] Module `crm`: `category: sales`, `requires.modules: ["care"]`, bảng `crm_note_index`, `crm_sync_conflicts` (SQL ở mục 5.3.2 của kế hoạch). `crm_orders` và `crm_scores` để T09.
- [ ] `slug.ts`: bỏ dấu, viết thường, nối gạch ngang; trùng thì thêm `-2`. Đổi tên khách không đổi tên file.
- [ ] **Từ SQLite ra file:** nghe `care:customer.changed`. Chưa có dòng trong `crm_note_index` thì `notes.create`. Có rồi thì `notes.patch` các khoá do SQLite sở hữu; các khoá kinh doanh chỉ ghi khi `mtime` của file bằng `note_mtime` đã lưu.
- [ ] **Từ file vào SQLite:** nghe `brain:changed` cho `khach-hang/*.md`. Bỏ qua thay đổi do chính module ghi (so `data_hash`). Kiểm lược đồ; sai thì không đồng bộ và nêu mục cần chú ý có tên file. Đúng thì `customers.update(id, patch, db_revision)`.
- [ ] **Xung đột:** `update` bị từ chối vì lệch `revision`. Đọc lại bản trong SQLite, với từng trường kinh doanh lệch nhau thì lấy giá trị của file, ghi một dòng `crm_sync_conflicts`, nêu mục cần chú ý.
- [ ] File mới không có `id`: tạo khách trong `care`, ghi `id` vào file.
- [ ] File bị xoá: không xoá khách. Đánh dấu trong `crm_note_index` và nêu mục cần chú ý với hai lựa chọn: tạo lại file, hoặc lưu trữ khách.
- [ ] Lần chạy đầu sau khi cài: tạo ghi chú cho mọi khách đang có, theo lô 50, không chặn khởi động.
- [ ] Phần thân ghi chú có hai mục máy quản lý, đặt giữa hai dòng đánh dấu: "Khách cần gì" (từ `care_profiles`) và "Nhật ký" (20 mục gần nhất, mỗi mục một dòng tóm tắt, không chép nguyên tin nhắn). Ngoài hai khối đó là của người viết, máy không đụng.

## Hợp đồng

Thuộc tính của ghi chú khách: mục 4.2 của kế hoạch. Ánh xạ `giai_doan`:

| File | `care_customers.stage` |
|---|---|
| `moi` | `new` |
| `dang-tu-van` | `consulting` |
| `da-bao-gia` | `quoted` |
| `dat-coc` | `deposit` |
| `da-chot` | `won` |
| `mat` | `lost` |

## Test

Dùng `createTestHarness` (`src/modules/test-deps.ts`) với module `care` thật và thư mục brain tạm.

- Tạo khách, có file đúng thuộc tính.
- Sửa `giai_doan` trong file, `stage` trong SQLite đổi.
- Sửa trong app, file đổi, phần thân người viết còn nguyên.
- Hai bên cùng sửa `sdt`: giá trị của file thắng, có một dòng xung đột.
- File có `giai_doan: abc`: SQLite không đổi, có mục cần chú ý.
- Xoá file: khách còn nguyên.
- Vòng lặp: một lần sửa không gây chuỗi ghi qua lại (đếm số lần ghi).

## Xong khi

- `npx vitest run modules/crm modules/care` qua.
- Trên máy thật: nhắn Zalo từ một số lạ, trong 5 giây có file khách mới.

## Ghi chú

Nhật ký trong ghi chú là tóm tắt, vì toàn bộ tin nhắn thành file sẽ làm thư mục phình nhanh và đưa lời khách vào chỗ bot đọc như kiến thức.
