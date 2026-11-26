# T19 · Cloud 1: khung, đăng nhập Google, quản lý người dùng

> Nhánh Cloud · 3 ngày · Phụ thuộc: không · Giả định G1, G2, G3 trong README

## Mục tiêu

Một dịch vụ nhỏ, không cần máy chủ riêng, biết người dùng là ai và cho quản trị viên quản lý người dùng. Không chạy AI, không giữ dữ liệu khách của shop.

## Quyết định kỹ thuật

| Mục | Chọn | Lý do |
|---|---|---|
| Khung HTTP | Hono | Cùng khung với lõi AIOS |
| Nơi chạy | Cloudflare Workers | Không nuôi máy chủ; chỉ tốn khi có người gọi |
| Cơ sở dữ liệu | Cloudflare D1 (SQLite) | Cùng họ SQLite với lõi |
| Tệp | Cloudflare R2 | T20, T21 |
| Xác minh Google | `jose`, đọc bộ khoá công khai của Google | Chạy được trên Workers |
| Phiên | Mã ngẫu nhiên, lưu dạng băm trong D1 | Thu hồi được ngay |

Code nghiệp vụ không gọi API riêng của Node hay của Workers; mọi thứ phụ thuộc nền tảng (cơ sở dữ liệu, kho tệp, đồng hồ, số ngẫu nhiên) đi qua một giao diện `Env`. Nhờ vậy sau này thêm được điểm vào chạy bằng Node mà không sửa nghiệp vụ.

## Cấu trúc

```
cloud/
  package.json  wrangler.jsonc  tsconfig.json  vitest.config.ts
  migrations/0001_init.sql
  src/
    index.ts            điểm vào Workers
    app.ts              dựng Hono app
    env.ts              giao diện Env
    http/               errors.ts, auth.ts (middleware), rate-limit.ts
    auth/google.ts      xác minh ID token
    auth/session.ts
    routes/auth.ts  routes/me.ts  routes/admin-users.ts
    db/                 câu lệnh D1
```

## Bảng

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY, google_sub TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
  name TEXT, avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at INTEGER NOT NULL, last_seen_at INTEGER
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('mobile','machine','web')),
  label TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE login_codes (            -- mã một lần cho luồng đăng nhập trên máy tính
  code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, state TEXT NOT NULL,
  expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
  target TEXT, detail TEXT, at INTEGER NOT NULL
);
```

## API

| Method | Path | Thân | Trả về |
|---|---|---|---|
| POST | `/auth/google` | `{ idToken, kind, label? }` | `{ token, user }` |
| GET | `/auth/web/start` | `?return=<url trên 127.0.0.1>&state=` | Chuyển hướng sang Google |
| GET | `/auth/web/callback` | từ Google | Chuyển hướng về `return` kèm `code` |
| POST | `/auth/exchange` | `{ code, state }` | `{ token, user }` |
| POST | `/auth/logout` | — | `{ ok: true }` |
| GET | `/me` | — | `{ user, sessions }` |
| DELETE | `/me/sessions/:id` | — | `{ ok: true }` |
| DELETE | `/me` | — | Xoá tài khoản và mọi phiên |
| GET | `/admin/users` | `?q=&status=&cursor=` | `{ items, next }` |
| PATCH | `/admin/users/:id` | `{ status?, role? }` | `user` |
| GET | `/admin/audit` | `?cursor=` | `{ items, next }` |

Lỗi có dạng `{ error: { code, message } }`, cùng định dạng với `docs/dev/API.md`.

## Các bước

- [ ] Dựng khung, `wrangler.jsonc` với D1 và R2 (chưa dùng R2 ở task này), migration đầu.
- [ ] `auth/google.ts`: xác minh chữ ký bằng bộ khoá của Google; kiểm `iss` là Google, `aud` nằm trong danh sách client id cho phép (iOS, Android, web), còn hạn, `email_verified` là thật. Thiếu điều kiện nào cũng từ chối.
- [ ] `POST /auth/google`: tạo người dùng nếu chưa có (theo `google_sub`, không theo email), cập nhật tên và ảnh, tạo phiên. Người dùng `disabled` thì trả 403.
- [ ] Phiên: mã 32 byte ngẫu nhiên, chỉ lưu SHA-256. Hạn 90 ngày cho `mobile` và `machine`, 12 giờ cho `web`. Mỗi lần dùng cập nhật `last_seen_at`, tối đa một lần ghi mỗi 5 phút để đỡ tốn lượt ghi D1.
- [ ] Luồng máy tính: `return` chỉ được là `http://127.0.0.1:<cổng>/…` hoặc `http://localhost:<cổng>/…`. Mã một lần sống 2 phút, dùng một lần, gắn với `state`.
- [ ] Middleware phiên; middleware `requireAdmin`.
- [ ] Khoá tài khoản (`status='disabled'`) thu hồi mọi phiên của người đó trong cùng một giao dịch.
- [ ] Quản trị viên đầu tiên: biến môi trường `ADMIN_EMAILS`. Người đăng nhập có email trong danh sách được `role='admin'`. Quản trị viên không tự hạ quyền mình khi là người cuối cùng.
- [ ] Giới hạn tần suất cho `/auth/*` theo IP (`CF-Connecting-IP`), đếm trong D1 theo cửa sổ cố định.
- [ ] Mọi thao tác quản trị ghi `audit`.
- [ ] Log không bao giờ chứa mã phiên, ID token, hay mã một lần.

## Test

Dùng `vitest` với `@cloudflare/vitest-pool-workers` (D1 trong bộ nhớ). Giả bộ khoá Google bằng một cặp khoá sinh trong test.

- ID token đúng tạo phiên; sai chữ ký, sai `aud`, hết hạn, `email_verified` sai đều bị từ chối.
- Đăng nhập lần hai bằng cùng `google_sub` nhưng email đã đổi: vẫn là một người dùng.
- Khoá tài khoản: phiên đang có trả 401 ngay.
- `return` trỏ ra tên miền ngoài bị từ chối.
- Mã một lần dùng lần hai bị từ chối.
- Người thường gọi `/admin/*` nhận 403.

## Xong khi

- `cd cloud && npx vitest run && npx tsc --noEmit` qua.
- `wrangler dev` chạy được; có file `cloud/README.md` ghi cách tạo D1, R2, client id Google và các secret.

## Ghi chú

- Không lưu refresh token của Google. Chỉ dùng ID token để biết danh tính.
- Chính sách cửa hàng ứng dụng đòi có đường xoá tài khoản; `DELETE /me` là để đáp ứng điều đó.
