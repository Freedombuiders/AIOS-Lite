# T22 · Nhập gói vào brain trên máy

> Nhánh Cloud · 2 ngày · Phụ thuộc: T01, T20 · Giả định G5, G7 trong README

## Mục tiêu

Người dùng bấm tải một gói. Ghi chú của gói vào đúng chỗ trong brain, bot đọc được ngay, và không gì trong gói được tin mù quáng.

## File đụng tới

| File | Loại |
|---|---|
| `src/integrations/agenticos-cloud/` | SỬA hoặc MỚI: đăng nhập cloud, gọi API kho (phần tải ảnh đã có ở T21) |
| `src/packs/` (`verify.ts`, `import.ts`, `rules.ts`) | MỚI |
| `src/core/migrations/00X_packs.ts` | MỚI |
| `src/api/routes/packs.ts` | MỚI |
| `web/src/pages/packs/` | MỚI: trang Kho dữ liệu |
| `config/…` | Khoá công khai của người phát hành |

## Bảng

```sql
CREATE TABLE pack_installs (
  pack_id TEXT NOT NULL, version TEXT NOT NULL, folder_id TEXT NOT NULL,
  installed_at INTEGER NOT NULL, PRIMARY KEY (pack_id, folder_id)
);
CREATE TABLE pack_files (
  pack_id TEXT NOT NULL, folder_id TEXT NOT NULL, rel_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,            -- băm nội dung lúc máy ghi
  PRIMARY KEY (pack_id, folder_id, rel_path)
);
```

## Các bước

- [ ] Đăng nhập cloud trên máy: nút mở trình duyệt tới `/auth/web/start` của cloud với `return` trỏ về `http://127.0.0.1:<cổng>/api/cloud/callback`; đổi mã lấy phiên; lưu phiên trong `integration_credentials` (đã mã hoá).
- [ ] Trang Kho dữ liệu: danh sách gói theo module, chi tiết gói (danh sách file, giấy phép, tác giả), nút cài, và dấu "có bản mới".
- [ ] Tải về: lấy đường dẫn ký sẵn, tải vào thư mục tạm, kiểm kích thước và SHA-256.
- [ ] `verify.ts`: kiểm chữ ký Ed25519 bằng khoá công khai trong cấu hình máy. Sai thì xoá file, báo lỗi, không mở zip.
- [ ] Mở zip với các chặn: tổng dung lượng sau giải nén tối đa 100 MB, tối đa 500 file, từ chối đường dẫn có `..`, đường dẫn tuyệt đối, và liên kết tượng trưng. Chỉ nhận `notes/**/*.md` và `assets/**`.
- [ ] `rules.ts`, luật theo `loai` khi nhập:

| `loai` | Luật |
|---|---|
| `bai-hoc` | Ép `trang_thai: gia-thuyet`, xoá `dung_boi`, bỏ `bang_chung` |
| `cong-thuc` | Ép `trang_thai: chua-thu`, `da_lam: 0`, xoá `ket_qua` |
| `kenh-dream` | Tạo kênh ở trạng thái tạm dừng; chủ tự bật, trong trần 100 |
| `khach-hang`, `bai-dang`, `tong-ket` | Từ chối. Gói không được mang dữ liệu loại này |
| không có `loai` | Chỉ nhận trong gói module `brain`, vào thư mục chủ chọn |

- [ ] Mọi ghi chú nhập vào được thêm `nguon_goi: <id>@<version>`.
- [ ] Ghi qua `NotesService` với `actor: 'system'`, lời nhắn commit `goi: cài <id>@<version>`. Cả gói là một commit, để hoàn tác một lần.
- [ ] Không ghi đè việc của người dùng: file đã có mà băm khác với `pack_files.sha256` (người đã sửa), hoặc có mà không thuộc gói nào, thì bỏ qua file đó và liệt kê trong kết quả.
- [ ] Cập nhật lên bản mới: file gói bỏ đi mà người dùng chưa sửa thì xoá; đã sửa thì giữ.
- [ ] Gỡ gói: xoá các file chưa bị sửa, giữ file đã sửa, bằng một commit.
- [ ] Trước khi cài, hiện bản xem trước: sẽ thêm bao nhiêu ghi chú, vào thư mục nào, bỏ qua file nào.

## Test

- Gói mẫu của T20 cài được; số ghi chú đúng; mọi bài học là `gia-thuyet`.
- Chữ ký sai: không có file nào được ghi.
- Zip có đường dẫn `notes/../../.env`: bị từ chối toàn bộ.
- Zip bom (tỷ lệ nén cực cao): dừng ở trần 100 MB.
- Gói có `loai: khach-hang`: bị từ chối.
- Người dùng sửa một ghi chú rồi cập nhật gói: ghi chú đó còn nguyên.
- Gỡ gói rồi `git log` cho thấy đúng hai commit (cài, gỡ).

## Xong khi

- `npx vitest run src/packs` qua.
- Trên máy thật với `wrangler dev`: cài gói mẫu, bot Nội dung thấy bài học mới trong kết quả tìm brain, và Sổ bài học có thêm các giả thuyết.

## Ghi chú

Nội dung gói đi vào prompt của bot, nên nó là dữ liệu không đáng tin dù đã có chữ ký. Chữ ký chỉ chứng minh ai phát hành; đường bọc `untrusted()` khi tìm brain vẫn áp dụng như mọi ghi chú khác.
