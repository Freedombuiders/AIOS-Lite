# T21 · R2 cho ảnh và video đăng bài

> Nhánh Cloud · 2 ngày · Phụ thuộc: T19 · Giả định G6 trong README

## Mục tiêu

Người dùng tải ảnh, video lên R2 trực tiếp từ máy hoặc điện thoại. Có đường dẫn công khai tạm thời để các nền tảng đăng bài lấy file. Chi phí lưu trữ tự giới hạn.

## Vì sao cần

Đăng ảnh, video lên Instagram, TikTok, Facebook qua Composio cần một đường dẫn mà máy chủ của nền tảng tải được. Máy của chủ shop nằm sau mạng nhà nên không cấp được đường dẫn đó.

Trước khi viết, kiểm `modules/kol/server/platforms/*` và `modules/marketing/server/core/publisher.ts:128-177` đang lấy đường dẫn ảnh từ đâu. Nếu đã có một cách khác đang chạy, ghi lại và chỉ thêm R2 như một lựa chọn.

## Bảng

```sql
CREATE TABLE uploads (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  r2_key TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL, size INTEGER,
  purpose TEXT NOT NULL CHECK (purpose IN ('post-media','avatar','pack-cover')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','deleted')),
  created_at INTEGER NOT NULL, expires_at INTEGER
);
```

## API

| Method | Path | Thân | Trả về |
|---|---|---|---|
| POST | `/uploads` | `{ contentType, size, purpose }` | `{ id, uploadUrl, headers, expiresAt }` |
| POST | `/uploads/:id/complete` | — | `{ id, url, expiresAt }` |
| GET | `/uploads` | `?purpose=` | Danh sách của người gọi |
| DELETE | `/uploads/:id` | — | `{ ok: true }` |

## Các bước

- [ ] `POST /uploads`: kiểm loại file trong danh sách cho phép (`image/jpeg`, `image/png`, `image/webp`, `video/mp4`), kích thước tối đa (ảnh 10 MB, video 200 MB), và hạn mức của người dùng (mặc định 2 GB đang lưu). Trả đường dẫn PUT ký sẵn, sống 10 phút, ràng đúng `content-type` và `content-length`.
- [ ] Khoá R2 có dạng `u/<userId>/<purpose>/<id>.<đuôi>`. Tên file gốc của người dùng không vào khoá.
- [ ] `complete`: đọc đầu đối tượng trên R2 để lấy kích thước thật; lệch với khai báo thì xoá và trả lỗi. Kiểm vài byte đầu khớp loại file.
- [ ] Đường dẫn đọc cho `post-media`: đường dẫn GET ký sẵn, sống 24 giờ. Không mở công khai cả thùng chứa.
- [ ] `post-media` có `expires_at` = 7 ngày sau khi tạo. Một việc định kỳ của Workers (cron) mỗi ngày xoá đối tượng hết hạn và các bản `pending` quá 1 giờ.
- [ ] `avatar` và `pack-cover` không hết hạn; thay ảnh mới thì xoá ảnh cũ.
- [ ] Xoá tài khoản (`DELETE /me`, T19) xoá mọi đối tượng dưới `u/<userId>/`.
- [ ] Phía máy: thêm integration `agenticos-cloud` trong lõi (`src/integrations/`), có lệnh `upload` nhận đường dẫn file trong máy và trả đường dẫn đọc. Phiên cloud của máy lưu trong `integration_credentials` (đã mã hoá).

## Test

- Loại file ngoài danh sách bị từ chối trước khi cấp đường dẫn.
- Khai 1 MB nhưng tải 5 MB: `complete` thất bại và đối tượng bị xoá.
- Vượt hạn mức: từ chối.
- Người A không đọc, không xoá được file của người B.
- Việc dọn dẹp xoá đúng file hết hạn, không đụng `avatar`.

## Xong khi

- `cd cloud && npx vitest run` qua.
- Từ máy: tải một ảnh lên, nhận đường dẫn, mở được trong trình duyệt ẩn danh; sau khi xoá thì không mở được.

## Ghi chú

- Đặt luật vòng đời của R2 như một lớp bảo vệ thứ hai: xoá mọi thứ dưới tiền tố `post-media` sau 14 ngày, kể cả khi việc dọn dẹp hỏng.
- Không tạo ảnh thu nhỏ trên cloud. Việc đó tốn thời gian tính toán; làm ở máy người dùng nếu cần.
