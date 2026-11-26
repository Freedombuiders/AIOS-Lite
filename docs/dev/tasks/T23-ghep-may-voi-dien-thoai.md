# T23 · Ghép máy với điện thoại

> Nhánh Cloud · 3 ngày · Phụ thuộc: T19 · Giả định G1, G2 trong README

## Mục tiêu

Điện thoại của chủ shop gọi được máy ở nhà từ bất cứ đâu. Cloud chỉ giúp hai bên tìm thấy nhau; không dữ liệu nào của shop đi qua cloud.

## Vấn đề phải giải trước

Lõi hiện chỉ có một người dùng với một mã `AIOS_TOKEN` tuỳ chọn, không có bảng người dùng hay thiết bị, và nghe ở `127.0.0.1:4380`. Mở lõi ra mạng mà không siết lại là mở toàn quyền. Vì vậy task này **không** đưa API lõi ra ngoài. Nó dựng một cổng riêng, hẹp, cho điện thoại.

## Thiết kế

```
Điện thoại ──(1) đăng nhập Google──► Cloud ◄──(2) máy đăng ký: khoá công khai, địa chỉ đường hầm── Máy
Điện thoại ──(3) xin vé ghép──► Cloud  (vé ký, sống 5 phút, ghi rõ máy nào, người nào)
Điện thoại ──(4) đưa vé──► Máy qua đường hầm ──► máy kiểm vé, cấp mã thiết bị
Điện thoại ──(5) gọi API di động bằng mã thiết bị──► Máy    (cloud không còn tham gia)
```

- **Cổng di động:** một app Hono thứ hai trong lõi, nghe ở cổng riêng (mặc định 4382), chỉ có các đường `/mobile/*`.
- **Đường hầm:** `cloudflared` chạy trên máy, trỏ vào cổng 4382. Bản đầu dùng đường hầm nhanh không cần tài khoản; địa chỉ đổi mỗi lần khởi động nên máy báo lại cho cloud.
- **Vé ghép:** JWT do cloud ký (ES256), `sub` là người dùng, `aud` là mã máy, hạn 5 phút, dùng một lần.

## File đụng tới

| File | Loại |
|---|---|
| `cloud/src/routes/machines.ts`, `cloud/migrations/0003_machines.sql`, `cloud/src/keys/` | MỚI |
| `src/mobile/` (`server.ts`, `auth.ts`, `tunnel.ts`, `routes/`) | MỚI |
| `src/core/migrations/00X_devices.ts` | MỚI |
| `src/main.ts` | SỬA: bật cổng di động khi cài đặt cho phép |
| `web/src/pages/settings/…` | SỬA: mục "Điện thoại" |

## Bảng

```sql
-- cloud
CREATE TABLE machines (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), label TEXT NOT NULL,
  public_key TEXT NOT NULL, tunnel_url TEXT, last_seen_at INTEGER, created_at INTEGER NOT NULL
);
-- máy
CREATE TABLE devices (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,              -- JSON: ["read","approve","reply"]
  cloud_user_id TEXT NOT NULL, push_token TEXT,
  created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER
);
CREATE TABLE used_pair_tickets (jti TEXT PRIMARY KEY, used_at INTEGER NOT NULL);
```

## Các bước

**Cloud**

- [ ] `POST /machines` (phiên loại `machine`): đăng ký máy với khoá công khai. `PUT /machines/:id/tunnel`: báo địa chỉ đường hầm, thân phải có chữ ký bằng khoá riêng của máy.
- [ ] `GET /machines`: máy của người gọi. `DELETE /machines/:id`.
- [ ] `POST /machines/:id/pair-ticket` (phiên loại `mobile`, cùng người dùng với máy): trả vé ghép.
- [ ] `GET /.well-known/jwks.json`: khoá công khai để máy kiểm vé.

**Máy**

- [ ] Lúc bật tính năng: sinh cặp khoá của máy, lưu khoá riêng đã mã hoá, đăng ký với cloud.
- [ ] `tunnel.ts`: chạy `cloudflared` bằng `execFile`, đọc địa chỉ từ đầu ra, báo cho cloud, tự chạy lại khi rớt. Thiếu `cloudflared` thì báo rõ cách cài; không tự tải về.
- [ ] `POST /mobile/pair`: kiểm chữ ký vé bằng bộ khoá của cloud, `aud` đúng mã máy, `sub` đúng người đã đăng nhập cloud trên máy này, còn hạn, `jti` chưa dùng. Cấp mã thiết bị 32 byte, lưu dạng băm.
- [ ] Middleware `/mobile/*`: mã thiết bị, kiểm phạm vi theo từng đường, giới hạn tần suất theo thiết bị.
- [ ] Bộ đường đầu tiên, chỉ đọc: `GET /mobile/me`, `GET /mobile/attention`. Các đường khác do T25 thêm.
- [ ] Cổng 4382 chỉ nghe `127.0.0.1`. Chỉ đường hầm mới ra ngoài.
- [ ] Mục "Điện thoại" trong Cài đặt: bật, tắt; danh sách thiết bị; thu hồi từng cái. Tắt là dừng đường hầm và đóng cổng.
- [ ] Mặc định **tắt**. Bật lên có một màn giải thích điều gì được mở ra.

## Test

- Vé ký sai, hết hạn, sai `aud`, sai `sub`, dùng lần hai: đều bị từ chối.
- Mã thiết bị bị thu hồi trả 401 ngay.
- Thiết bị chỉ có phạm vi `read` gọi đường cần `approve` nhận 403.
- Qua cổng 4382 không gọi được bất kỳ đường `/api/*` nào của lõi (test liệt kê vài đường nhạy cảm).
- Máy báo địa chỉ đường hầm với chữ ký sai: cloud từ chối.

## Xong khi

- `npx vitest run src/mobile` và `cd cloud && npx vitest run` qua.
- Thử thật: bật tính năng, dùng `curl` với một vé ghép lấy mã thiết bị, rồi gọi `GET /mobile/attention` qua địa chỉ đường hầm.

## Ghi chú

- Đường hầm nhanh không có cam kết về độ ổn định. Nếu cần ổn định, bước sau là đường hầm có tên; GenBot đã làm việc này bằng một Worker cấp đường hầm cho từng máy (`genbot/cloudflare/genbot-tunnel`), tham khảo cách làm, không chép code.
- Người cùng mạng nội bộ không cần đường hầm. Đó là một tối ưu về sau, không làm ở bản này.
