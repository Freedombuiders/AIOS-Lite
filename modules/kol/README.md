# KOL Studio

Module `kol` (nhóm menu **Studio**): vận hành KOL ảo giữ nguyên khuôn mặt, từ hồ sơ nhận diện đến bài đăng đa nền tảng.

## Chức năng

- **KOL**: hồ sơ (ngoại hình, tính cách, tuyến nội dung), gói nhận diện (ảnh gốc, ảnh 360°, góc mặt), chấm độ giống mặt.
- **Studio**: tạo ảnh/video giữ đúng khuôn mặt (compose, tái tạo từ mẫu, character sheet, video từ ảnh, video nói chuyện), báo giá trước, hạn mức ngày/tháng.
- **Thư viện**: trang phục, biểu cảm, tóc, bối cảnh, dáng, hiệu ứng, máy ảnh; **Mẫu** để tái tạo.
- **Bài đăng**: soạn nội dung, biến thể theo nền tảng, lịch tuần, duyệt rồi đăng (Facebook, Instagram, TikTok, YouTube qua Composio).
- **Kênh** và **Tăng trưởng**: tài khoản đã liên kết, số liệu, chiến lược gia và autopilot.
- Màn hình: trang chủ KOL Studio (`/m/kol`) và không gian làm việc từng KOL (`/m/kol/:id`) với 9 tab.

## Cần gì để chạy

| Việc | Cần |
|---|---|
| Tạo ảnh/video | Một trong: fal.ai hoặc Higgsfield (Kết nối › Integrations), khóa `GOOGLE_API_KEY` (Gemini), hoặc `codex login` trên máy (gói ChatGPT) |
| Đăng bài | Composio (Kết nối); Facebook cần thêm module **Marketing** bật |
| Giọng nói (video nói chuyện) | ElevenLabs (Kết nối › Integrations) |
| Ý tưởng từ Radar | Module **Radar** (không bắt buộc) |

Ảnh/video sinh ra nằm ở `data/modules/kol/media`, phục vụ qua route của module.

## Quyền cho agent

| Scope | Cho phép |
|---|---|
| `kol.read` | Đọc KOL, thư viện, ảnh, bài đăng, tăng trưởng |
| `content.write` | Soạn/sửa bài nháp (chờ chủ duyệt, agent không duyệt hay đăng) |
| `media.generate` | Yêu cầu tạo ảnh/video (tốn tiền, trong hạn mức) |

Actions: `read`, `content.add`, `content.update`, `generation.request` (xem skill `kol-studio`). Agent mẫu: `kol-writer`.

## Công tắc

Cài đặt module: **Cho phép tạo ảnh/video** (`KOL_GENERATE_ENABLED`) và **Cho phép đăng bài của KOL** (`KOL_PUBLISH_ENABLED`). Trong KOL Studio › Cài đặt còn hạn mức USD ngày/tháng, giá ghi đè, autopilot, model mặc định.

## Giới hạn đã biết

- Chưa kiểm thật với fal, Higgsfield, Gemini, Codex, Composio (test dùng bản giả).
- Chi phí ghi ở bảng `kol_spend`; chưa nối vào module Costs.
- Đăng Facebook đọc/ghi bảng `fb_*` của Marketing (không có Marketing thì bài Facebook báo lỗi).

Chi tiết port: `PORTING.md`.
