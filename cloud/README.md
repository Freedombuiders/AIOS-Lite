# Open AgenticOS cloud

Dịch vụ nhỏ chạy trên Cloudflare Workers, D1 và R2. Nó chỉ làm ba việc:

1. Biết bạn là ai: đăng nhập Google, phiên đăng nhập, quản lý người dùng.
2. Cho bạn tải gì: kho gói dữ liệu có chữ ký.
3. Giữ tạm ảnh, video đăng bài để các nền tảng mạng xã hội lấy được.

Cloud không chạy AI và không giữ dữ liệu khách của shop. Mọi thứ nặng vẫn chạy trên máy của chủ shop.

## Cấu trúc

```
cloud/
  wrangler.jsonc          cấu hình Worker, D1, R2, cron
  migrations/             lược đồ D1, chạy theo thứ tự
  src/
    index.ts              điểm vào Workers (fetch + cron)
    app.ts                dựng Hono app
    env.ts                giao diện Env: db, kho tệp, đồng hồ, số ngẫu nhiên, fetch
    config.ts             đọc biến môi trường
    platform/             nối Env với D1, R2
    http/                 lỗi, middleware phiên, giới hạn tần suất
    auth/                 xác minh ID token Google, phiên, luồng đăng nhập máy tính
    routes/               các đường API
    db/                   câu lệnh D1
    services/             xoá tài khoản, dọn dẹp định kỳ
  test/                   bộ khung test (D1, R2 trong bộ nhớ, khoá Google giả)
```

Code nghiệp vụ chỉ dùng nền tảng qua `Env` (`src/env.ts`). Muốn chạy bằng Node thì viết một `Env` khác (better-sqlite3, S3), không phải sửa route.

## Chạy cục bộ

```sh
cd cloud
npm install
npm run db:migrate:local      # tạo bảng trong D1 cục bộ (.wrangler/state)
npm run dev                   # wrangler dev với DEV_MODE=1
npm test                      # vitest, chạy trong workerd, không gọi mạng
npm run typecheck
```

`npm run dev` bật `DEV_MODE`. Chế độ này chỉ có tác dụng khi request tới `localhost` hoặc `127.0.0.1`, và mở thêm:

- `POST /auth/dev` với `{ "email": "…" }`: đăng nhập không qua Google, để thử luồng cục bộ. Email nằm trong `ADMIN_EMAILS` sẽ là quản trị viên, ví dụ `npx wrangler dev --var DEV_MODE:1 --var ADMIN_EMAILS:ban@example.com`.

Không bao giờ đặt `DEV_MODE` trên bản chạy thật.

## Dựng trên Cloudflare

Các bước dưới đây cần tài khoản Cloudflare và Google Cloud thật.

### 1. D1

```sh
npx wrangler d1 create agenticos-cloud
```

Chép `database_id` vào `wrangler.jsonc`, rồi tạo bảng:

```sh
npx wrangler d1 migrations apply DB --remote
```

### 2. R2

```sh
npx wrangler r2 bucket create agenticos-cloud
```

Đường dẫn tải lên, tải về được ký bằng API S3 của R2, nên cần một khoá API R2:

1. Cloudflare dashboard › R2 › Manage R2 API Tokens › Create API token, quyền Object Read & Write, giới hạn vào thùng `agenticos-cloud`.
2. Ghi `R2_ACCOUNT_ID` (mã tài khoản Cloudflare) và `R2_BUCKET_NAME` vào `vars` trong `wrangler.jsonc`.
3. Đặt hai secret:

```sh
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

Không mở công khai thùng chứa. Mọi đường đọc đều là đường dẫn ký sẵn có hạn.

### 3. Google client id

Trong Google Cloud Console › APIs & Services › Credentials, tạo OAuth client:

| Loại | Dùng cho | Ghi vào |
|---|---|---|
| Web application | Đăng nhập trên máy tính (`/auth/web/*`) và web | `GOOGLE_WEB_CLIENT_ID`, secret `GOOGLE_WEB_CLIENT_SECRET` |
| iOS | App Expo trên iPhone | thêm vào `GOOGLE_CLIENT_IDS` |
| Android | App Expo trên Android | thêm vào `GOOGLE_CLIENT_IDS` |

Với client web, thêm Authorized redirect URI là `https://<tên miền của Worker>/auth/web/callback`, và đặt `PUBLIC_URL` đúng tên miền đó.

```sh
npx wrangler secret put GOOGLE_WEB_CLIENT_SECRET
```

`GOOGLE_CLIENT_IDS` là danh sách client id được chấp nhận làm `aud` của ID token, cách nhau bằng dấu phẩy. Client web tự được thêm vào danh sách.

### 4. Quản trị viên đầu tiên

Đặt `ADMIN_EMAILS` (cách nhau bằng dấu phẩy). Ai đăng nhập bằng email trong danh sách sẽ thành quản trị viên. Danh sách chỉ nâng quyền, không hạ quyền. Không hạ quyền hay khoá được quản trị viên cuối cùng.

### 5. Triển khai

```sh
npx wrangler deploy
```

## Biến môi trường

| Tên | Loại | Ý nghĩa |
|---|---|---|
| `GOOGLE_CLIENT_IDS` | var | Client id Google được chấp nhận, cách nhau bằng dấu phẩy |
| `GOOGLE_WEB_CLIENT_ID` | var | Client web cho luồng đăng nhập trên máy tính |
| `GOOGLE_WEB_CLIENT_SECRET` | secret | Secret của client web |
| `ADMIN_EMAILS` | var | Email được làm quản trị viên |
| `PUBLIC_URL` | var | Địa chỉ công khai của Worker, dùng cho redirect URI |
| `AUTH_RATE_LIMIT` | var | Số request `/auth/*` mỗi phút mỗi IP, mặc định 30 |
| `R2_ACCOUNT_ID`, `R2_BUCKET_NAME` | var | Nơi ký đường dẫn S3 của R2 |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | secret | Khoá API R2 |
| `PACK_SIGNING_KEYS` | var | Khoá công khai kiểm chữ ký gói, xem phần Kho dữ liệu |
| `UPLOAD_QUOTA_BYTES` | var | Hạn mức lưu tệp mỗi người, mặc định 2 GB |
| `DEV_MODE` | var | Chỉ dùng cục bộ, xem trên |

## API

Lỗi có dạng `{ "error": { "code", "message" } }`, cùng định dạng với `docs/dev/API.md`. Thời gian trả về theo ISO-8601 UTC. Đường cần đăng nhập đọc header `Authorization: Bearer <token>`.

### Đăng nhập và người dùng

| Method | Path | Thân | Trả về |
|---|---|---|---|
| POST | `/auth/google` | `{ idToken, kind: mobile\|machine\|web, label? }` | `{ token, user, session }` |
| GET | `/auth/web/start` | `?return=http://127.0.0.1:<cổng>/…&state=` | Chuyển sang Google |
| GET | `/auth/web/callback` | từ Google | Chuyển về `return` kèm `code` và `state`, hoặc `error` |
| POST | `/auth/exchange` | `{ code, state, kind?: machine\|web, label? }` | `{ token, user, session }` |
| POST | `/auth/logout` | — | `{ ok: true }` |
| GET | `/me` | — | `{ user, sessions }` |
| DELETE | `/me/sessions/:id` | — | `{ ok: true }` |
| DELETE | `/me` | — | `{ ok: true }`, xoá tài khoản và mọi phiên |
| GET | `/admin/users` | `?q=&status=&cursor=` | `{ items, next }` |
| PATCH | `/admin/users/:id` | `{ status?, role? }` | `user` |
| GET | `/admin/audit` | `?cursor=` | `{ items, next }` |

Phiên là mã 32 byte ngẫu nhiên; cloud chỉ lưu SHA-256. Hạn 90 ngày cho `mobile`, `machine`; 12 giờ cho `web`. Khoá tài khoản thu hồi mọi phiên của người đó trong cùng một giao dịch.

Luồng đăng nhập trên máy tính: app trên máy mở trình duyệt tới `/auth/web/start` với `return` trỏ về cổng cục bộ của nó và một `state` ngẫu nhiên. Google gọi lại `/auth/web/callback`; cloud kiểm ID token (kể cả `nonce`, có PKCE), rồi đưa trình duyệt về `return?code=…&state=…`. Mã sống 2 phút, dùng một lần, phải đi kèm đúng `state` ở `POST /auth/exchange`.

### Kho dữ liệu

| Method | Path | Ai | Trả về |
|---|---|---|---|
| GET | `/packs` `?module=&industry=&q=` | người dùng | `{ items }`, mỗi gói kèm bản phát hành mới nhất |
| GET | `/packs/:id` | người dùng | Gói, giấy phép, các bản phát hành, danh sách file trong bản mới nhất |
| POST | `/packs/:id/releases/:version/download` | người dùng | `{ url, expiresAt, sha256, signature, keyId, size }` |
| GET | `/packs/updates` `?have=id@ver,id@ver` | người dùng | `{ items }`: gói có bản mới hơn, hoặc bản đang có đã bị thu hồi |
| POST | `/admin/packs` | quản trị | Tạo gói `{ id, module, name, summary?, industry?, visibility? }` |
| PATCH | `/admin/packs/:id` | quản trị | Sửa tên, mô tả, ngành, chế độ hiển thị |
| POST | `/admin/packs/:id/releases` | quản trị | `{ version, size }` → `{ releaseId, uploadUrl, headers, expiresAt }` |
| POST | `/admin/releases/:id/finalize` | quản trị | Kiểm zip, lưu manifest, chờ phát hành |
| POST | `/admin/releases/:id/publish` | quản trị | `{ signature, keyId }`, kiểm chữ ký rồi phát hành |
| POST | `/admin/releases/:id/yank` | quản trị | Thu hồi: ẩn khỏi danh sách, không xoá file |

Định dạng gói, luật kiểm và nội dung được ký: xem `sample-packs/README.md`.

Đường tải về là đường dẫn R2 ký sẵn, sống 5 phút; Worker không chuyển tiếp dữ liệu. Mỗi người tải tối đa 60 lượt mỗi giờ. Bản đã phát hành không sửa được: zip được tải lên vào `incoming/`, `finalize` kiểm rồi chép sang `packs/<id>/<version>.zip`, nên đường tải lên cũ không ghi đè được bản đã kiểm.

#### Phát hành một gói

Khoá bí mật chỉ nằm trên máy người phát hành.

```sh
# Một lần: tạo cặp khoá, chép khoá công khai vào PACK_SIGNING_KEYS
npm run pack -- keygen --out ~/.agenticos-keys --key-id k2026

# Mỗi bản phát hành
npm run pack -- build sample-packs/tra-va-qua-tang-co-ban --out tra.zip
npm run pack -- sign tra.zip --key ~/.agenticos-keys/k2026.pem --key-id k2026
export AGENTICOS_CLOUD_URL=https://cloud.example.com
export AGENTICOS_CLOUD_TOKEN=…      # phiên của một quản trị viên
npm run pack -- publish tra.zip --sig tra.zip.sig.json

# Kiểm: tải về, so SHA-256 và chữ ký
npm run pack -- download tra-va-qua-tang-co-ban 1.0.0 --pubkey <khoá công khai base64>
```

Thử trên `wrangler dev`: chạy với `--var DEV_MODE:1 --var ADMIN_EMAILS:… --var 'PACK_SIGNING_KEYS:{"k2026":"…"}'`, lấy token bằng `POST /auth/dev`. Khi chưa có khoá R2, `DEV_MODE` cấp đường dẫn tới `/_dev/blobs/…` trên chính Worker cục bộ thay cho đường dẫn R2 thật. Đường này chỉ tồn tại khi bật `DEV_MODE` và gọi qua `localhost`.
