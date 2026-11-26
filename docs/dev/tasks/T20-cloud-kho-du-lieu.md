# T20 · Cloud 2: kho dữ liệu

> Nhánh Cloud · 3 ngày · Phụ thuộc: T19 · Giả định G5, G6, G7 trong README

## Mục tiêu

Người dùng duyệt và tải các gói dữ liệu theo module. Quản trị viên phát hành gói. File nằm trên R2; máy chủ không đứng giữa lúc tải.

## Định dạng gói

Một file zip:

```
pack.json
notes/<đường dẫn trong brain>.md     ghi chú có thuộc tính, theo mục 4 của kế hoạch
assets/<tên>                          ảnh minh hoạ, mỗi ảnh tối đa 512 KB
```

```json
{
  "id": "tra-va-qua-tang-co-ban",
  "version": "1.2.0",
  "name": "Trà và quà tặng: bộ khởi đầu",
  "module": "learn",
  "summary": "12 bài học nội dung và 6 công thức video ngắn",
  "minAppVersion": "0.1.0",
  "license": "CC-BY-4.0",
  "author": "…",
  "files": [
    { "path": "notes/bai-hoc/video-huong-dan-ngan.md", "sha256": "…", "loai": "bai-hoc" }
  ]
}
```

`module` là một trong: `brain` (mẫu brain theo ngành), `learn` (bài học), `dream` (công thức và danh sách kênh), `crm` (mẫu thuộc tính khách). `loai` của từng file phải thuộc danh sách cho phép của module đó.

Trần: gói tối đa 20 MB, tối đa 500 file.

## Chữ ký

- Quản trị viên ký SHA-256 của file zip bằng khoá Ed25519. Khoá bí mật không nằm trên cloud; ký ở máy người phát hành bằng một lệnh CLI.
- Cloud giữ chữ ký và mã định danh khoá. Máy người dùng kiểm chữ ký bằng khoá công khai gắn sẵn trong app (T22).
- Lý do: R2 hay tài khoản cloud bị chiếm thì kẻ tấn công vẫn không đẩy được nội dung vào brain của người dùng.

## Bảng

```sql
CREATE TABLE packs (
  id TEXT PRIMARY KEY, module TEXT NOT NULL, name TEXT NOT NULL, summary TEXT,
  industry TEXT, cover_key TEXT,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','unlisted')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE pack_releases (
  id TEXT PRIMARY KEY, pack_id TEXT NOT NULL REFERENCES packs(id), version TEXT NOT NULL,
  r2_key TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  signature TEXT NOT NULL, key_id TEXT NOT NULL, manifest_json TEXT NOT NULL,
  notes_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','yanked')),
  created_at INTEGER NOT NULL, published_at INTEGER,
  UNIQUE(pack_id, version)
);
CREATE TABLE downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, release_id TEXT NOT NULL, at INTEGER NOT NULL
);
```

## API

| Method | Path | Ai | Trả về |
|---|---|---|---|
| GET | `/packs` `?module=&industry=&q=` | người dùng | `{ items }`, mỗi gói kèm bản phát hành mới nhất |
| GET | `/packs/:id` | người dùng | Gói, các bản phát hành, danh sách file trong bản mới nhất |
| POST | `/packs/:id/releases/:version/download` | người dùng | `{ url, expiresAt, sha256, signature, keyId, size }` |
| GET | `/packs/updates` `?have=id@ver,id@ver` | người dùng | Gói nào có bản mới hơn |
| POST | `/admin/packs` | quản trị | Tạo gói |
| POST | `/admin/packs/:id/releases` | quản trị | `{ uploadUrl, releaseId }` để tải zip thẳng lên R2 |
| POST | `/admin/releases/:id/finalize` | quản trị | Kiểm zip, lưu manifest, chờ phát hành |
| POST | `/admin/releases/:id/publish` · `/yank` | quản trị | Đổi trạng thái |

## Các bước

- [ ] Migration và các đường đọc.
- [ ] Đường tải về trả một đường dẫn R2 ký sẵn, sống 5 phút. Worker không chuyển tiếp dữ liệu.
- [ ] `finalize`: đọc zip từ R2 trong Worker; kiểm kích thước, số file, `pack.json` đúng lược đồ, SHA-256 từng file khớp, không có đường dẫn chứa `..` hay bắt đầu bằng `/`, mọi file nằm dưới `notes/` hoặc `assets/`, `loai` hợp lệ với `module`. Sai thì xoá đối tượng khỏi R2 và trả lỗi nêu rõ file nào.
- [ ] `publish` đòi có `signature` và `key_id` hợp lệ: Worker kiểm chữ ký bằng danh sách khoá công khai trong cấu hình.
- [ ] Bản đã `published` không sửa được nội dung. Muốn sửa thì phát hành phiên bản mới. `yank` ẩn khỏi danh sách nhưng không xoá file.
- [ ] Ghi `downloads` mỗi lần cấp đường dẫn; giới hạn 60 lượt tải mỗi người mỗi giờ.
- [ ] CLI `cloud/scripts/pack.ts`: `build <thư mục>` (tạo zip và `pack.json` với SHA-256), `sign <zip> --key <file>`, `publish <zip> --sig <file>`.
- [ ] Viết một gói mẫu trong `cloud/sample-packs/` để thử và để làm tài liệu sống về định dạng.

## Test

- Gói hợp lệ đi hết luồng tạo, tải lên, `finalize`, `publish`, liệt kê, tải về.
- Zip có đường dẫn `notes/../../x.md` bị từ chối.
- Zip có file không khai trong `pack.json`, hoặc SHA-256 lệch, bị từ chối.
- Gói `learn` chứa ghi chú `loai: khach-hang` bị từ chối.
- `publish` với chữ ký sai bị từ chối.
- Người thường không gọi được đường quản trị.
- Bản `yanked` không còn trong `/packs` nhưng ai đã có `id@version` vẫn thấy cảnh báo ở `/packs/updates`.

## Xong khi

- `cd cloud && npx vitest run` qua.
- Dùng CLI phát hành được gói mẫu lên `wrangler dev`, rồi tải về và băm ra đúng SHA-256.

## Ghi chú

- Không cho người dùng thường tự đăng gói ở bản này. Nội dung gói đi thẳng vào prompt của bot người khác, nên phải có người duyệt.
- Giấy phép của gói ghi trong `pack.json` và hiện ở màn chi tiết.
