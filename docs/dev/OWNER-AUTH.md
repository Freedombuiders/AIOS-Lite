# Quyền chủ ở API lõi

> Task S1 (26/11/2026). Mã: `src/api/owner.ts`, test: `src/api/owner.test.ts`, giao diện: `web/src/lib/owner.ts`, `web/src/components/OwnerSignIn.tsx`.

## Vấn đề

API lõi nghe ở `127.0.0.1` và mặc định không đòi mã. Mọi tiến trình trên máy, kể cả CLI của agent có shell, gọi được mọi đường HTTP. "Đến từ localhost" không chứng minh được gì. Một ghi chú hay tin nhắn khách có cài chỉ dẫn có thể khiến agent `curl` thẳng vào đường duyệt nháp hoặc đăng bài.

## Cách làm

**Chủ** là một trong hai thứ:

1. Header `Authorization: Bearer <AIOS_TOKEN>`, khi máy chủ có đặt `AIOS_TOKEN`. Script và CLI `aios` dùng cách này, như trước.
2. Cookie phiên `aios_owner` của trình duyệt đã ghép với máy chủ. Cookie có `HttpOnly; SameSite=Strict; Path=/`, sống 30 ngày.

**Ghép trình duyệt lần đầu.** Khi khởi động, máy chủ in ra terminal của chính nó một mã dùng một lần và một liên kết:

```
──────── Đăng nhập chủ AIOS-Lite ────────
Mở liên kết này trong trình duyệt của bạn (dùng một lần, hết hạn sau 60 phút):
  http://127.0.0.1:4380/api/owner/pair?code=ABCD-EFGH-JKLM
Hoặc nhập mã ABCD-EFGH-JKLM ở màn hình "Đăng nhập chủ".
```

- Mã được in thẳng ra stdout bằng `process.stdout.write`, không đi qua logger. Mã cũng được đăng ký với `src/core/redact.ts`, nên nếu lỡ lọt vào log thì vẫn bị che.
- Mã chỉ nằm trong bộ nhớ. Mỗi mã dùng một lần, hết hạn sau 60 phút, và bị huỷ sau 5 lần đoán sai. Cùng lúc có tối đa 3 mã còn hiệu lực.
- Liên kết `GET /api/owner/pair?code=` chỉ nhận lượt mở trực tiếp (`Sec-Fetch-Site: none` hoặc `same-origin`). Liên kết bấm từ trang khác, hay từ một cổng localhost khác, đều bị từ chối.
- Màn hình "Đăng nhập chủ" trên web có ô nhập mã và nút **In mã mới**. Nút này gọi `POST /api/owner/pair/request`. Máy chủ in mã mới ra terminal và **không bao giờ trả mã về** trong phản hồi. Mỗi 20 giây chỉ in được một lần.
- Chủ đã đăng nhập có thể xin mã cho thiết bị khác: `POST /api/owner/pair-link`, đường này cần quyền chủ.
- Máy chủ chỉ lưu SHA-256 của token phiên, trong bảng `owner_sessions`. Đọc được cơ sở dữ liệu cũng không dùng lại được phiên.
- Khi chạy `npm run dev`, giao diện ở cổng 5173 và liên kết trỏ tới cổng 4380. Cookie gắn theo tên máy, không theo cổng, nên liên kết `127.0.0.1:4380` dùng được cho `127.0.0.1:5173`, nhưng không dùng được cho `localhost:5173`. Khi đó hãy nhập mã vào màn hình đăng nhập.
- Máy chỉ dùng `AIOS_TOKEN` thì đặt `AIOS_OWNER_PAIRING=off` để không in mã.

**Đường cần chủ.** Có đúng một danh sách là `OWNER_ROUTES` trong `src/api/owner.ts`. Nó gồm các đường: gửi tin cho khách (care, Zalo, trả lời bình luận), duyệt, sửa hoặc gửi nháp, duyệt, lên lịch hoặc đăng bài (marketing, KOL, video), ghi vào tài khoản quảng cáo và áp đề xuất, cài đặt module, đổi agent, quyền, skill, thư mục brain, khoá integration, duyệt lệnh integration, và cài gói team hay mẫu. Chỉ các method ghi (POST, PUT, PATCH, DELETE) mới bị chặn. Đường đọc và SSE vẫn mở như cũ.

- Không có quyền chủ: trả `401` với `{ error: { code: 'unauthorized' } }` và header `x-aios-owner: required`.
- Có cookie nhưng yêu cầu đến từ trang khác: trả `403` với header `x-aios-owner: cross-site`.

**Test phủ đường.** `owner.test.ts` dựng bảng route thật, gồm lõi, mọi module và route bên trong của KOL. Test **fail** khi có một đường ghi mà đường dẫn chứa một đoạn nhạy cảm (`SENSITIVE_SEGMENTS`: `send`, `approve`, `publish`, `schedule`, `ads`, `settings`, `agents`, `install`, `import`, `pack`...) nhưng không nằm trong `OWNER_ROUTES`, cũng không nằm trong `NOT_OWNER_ROUTES` kèm lý do. Test cũng fail khi một mục của danh sách không khớp route nào, để mục gõ sai không âm thầm bảo vệ khoảng trống.

**Chống CSRF.** Ngoài `SameSite=Strict` còn có kiểm tra nguồn:

- Header `Origin` phải trùng `Host` của request, hoặc nằm trong `AIOS_ALLOWED_ORIGINS` (danh sách cách nhau bằng dấu phẩy).
- `Sec-Fetch-Site`, nếu có, phải là `same-origin` hoặc `none`.

SameSite coi mọi cổng của `localhost` là cùng một site, nên riêng SameSite không chặn được một trang ở `localhost:3000`. Kiểm tra `Origin` chặn được. Mọi yêu cầu ghi từ trang khác đều bị chặn, kể cả ở đường không cần chủ, ví dụ một trang web tạo task trên máy. Request không có `Origin` lẫn `Sec-Fetch-Site` (curl, script) không phải từ trình duyệt, và tự nó không mang được cookie của chủ.

**Cầu MCP của agent.** `POST /api/integrations/call` và `GET /api/integrations/tools` vẫn dùng token riêng của từng lượt chạy, như trước. Token lượt chạy **không** phải quyền chủ. Đưa nó vào một đường của chủ sẽ nhận `401`.

**Khi bật `AIOS_TOKEN`.** Mọi đường vẫn đòi token như hôm nay. Phiên cookie của chủ cũng qua được cổng token. Riêng các đường ghép (`/api/owner/status`, `/api/owner/pair`, `/api/owner/pair/request`) mở mà không cần token.

## Giới hạn, nói thẳng

Agent có shell chạy dưới **cùng một user hệ điều hành** với máy chủ và trình duyệt. Rào này chặn được việc agent hoặc chỉ dẫn bị cấy vào **chỉ cần gọi API là xong**. Nó không phải hộp cát. Một agent quyết tâm vẫn có thể:

- đọc file `.env`, trong đó có `AIOS_TOKEN` nếu bạn đặt. `buildChildEnv` đã bỏ `AIOS_TOKEN` khỏi môi trường của agent, nhưng file thì vẫn đọc được;
- đọc kho cookie của trình duyệt. Chrome trên macOS mã hoá kho này bằng Keychain, Firefox thì không;
- đọc stdout của máy chủ, nếu bạn chuyển nó vào một file log mà agent đọc được (launchd, `> log.txt`);
- tắt rồi khởi động lại máy chủ, để tự đọc mã mới.

Muốn chặn hẳn thì phải chạy agent dưới một user khác hoặc trong container. Việc này để sau.

Phiên không gắn với một thiết bị cụ thể. Ai có cookie thì là chủ cho tới khi cookie hết hạn hoặc bị đăng xuất (`POST /api/owner/logout`).

## Còn lại

- Các đường tốn tiền nhưng không đăng hay gửi đi đâu chưa cần chủ: tạo ảnh hay video KOL, render video, tạo nháp video. Đó là `/api/m/kol/generations`, `/api/m/video/edit/projects/:id/render|run|ai-edit` và các đường tương tự. `/api/schedules` (lịch chạy agent) và `/api/tasks` cũng chưa cần chủ.
- Lệnh `aios module add|remove` cần `AIOS_TOKEN` khi máy chủ không đặt token. CLI sẽ báo rõ điều này.
