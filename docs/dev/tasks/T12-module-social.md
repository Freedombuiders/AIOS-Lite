# T12 · Module `social`

> Nhánh Marketing · 3 ngày · Phụ thuộc: T10 · Kế hoạch mục 5.5.1

## Mục tiêu

Một chỗ xem số liệu mọi kênh của shop: tổng quan, Facebook, YouTube. Không phụ thuộc module KOL Studio.

## Bản vẽ tham chiếu

`Social.dc.html`, `SocialFacebook.dc.html`, `SocialYoutube.dc.html`.

## File đụng tới

| File | Loại |
|---|---|
| `modules/_lib/social-stats/` | MỚI: tách từ `modules/kol/server/metrics.ts` và `accounts.ts:251-299` |
| `modules/kol/server/metrics.ts`, `accounts.ts` | SỬA: gọi thư viện chung |
| `modules/social/` | MỚI |
| `modules/marketing/server/index.ts` | SỬA nếu cần: `provides` phần phân tích |

## Các bước

- [ ] Tách các hàm đọc số liệu thành hàm thuần nhận `execute` của Composio: Instagram (`INSTAGRAM_GET_USER_INFO`, `INSTAGRAM_GET_IG_USER_MEDIA`, `INSTAGRAM_GET_IG_MEDIA_INSIGHTS`), YouTube (`YOUTUBE_GET_CHANNEL_STATISTICS`, `YOUTUBE_LIST_CHANNEL_VIDEOS`, `YOUTUBE_GET_VIDEO_DETAILS_BATCH`), TikTok (`TIKTOK_LIST_VIDEOS`, `TIKTOK_GET_USER_STATS`). Module `kol` chuyển sang dùng thư viện này; test của `kol` phải qua không sửa.
- [ ] Module `social`: `category: marketing`, `requires.modules: ["marketing"]`, `requires.connections: ["composio"]`. Bảng `social_accounts`, `social_account_daily`, `social_video_stats`.
- [ ] Việc định kỳ mỗi 30 phút bằng `ctx.schedule.every`. Mỗi lần chạy trừ vào ngân sách lượt gọi Composio sẵn có (`modules/_lib/composio.ts`, trần 600 mỗi giờ).
- [ ] Trạng thái từng kênh: Đã kết nối, Hết hạn cần nối lại, Chưa kết nối, Chưa nhập khoá Composio. Mỗi trạng thái có lời hướng dẫn riêng.
- [ ] Trang Tổng quan: thẻ từng kênh; khối Facebook đọc phân tích sẵn có của `marketing` (bốn chỉ số, reach mỗi ngày, điểm nhấn, tóm tắt của bot).
- [ ] Trang Facebook: sáu chỉ số có so với kỳ trước, phễu, ER theo định dạng, giờ vàng, bảng bài đăng. Mọi phép tính dùng lại `marketing/server/analytics/metrics.ts`; không viết lại công thức.
- [ ] Trang YouTube: năm chỉ số, lượt xem 12 video gần nhất, bảng video. Có khối ghi rõ chưa có giờ xem, tỷ lệ giữ chân, chuỗi theo ngày.
- [ ] TikTok và Instagram: chỉ thẻ ở Tổng quan. Chưa lấy được số thì ghi "chưa lấy số liệu", không để số 0.
- [ ] Bộ chọn khoảng 7, 28, 90 ngày; nút "Lấy số liệu mới" giới hạn một lần mỗi 10 phút.
- [ ] Biểu đồ: một màu cho một chuỗi, có chú thích khi rê chuột, có mô tả cho trình đọc màn hình.

## Test

- Thư viện `social-stats` với `execute` giả: đủ số, thiếu trường, lỗi quyền.
- Việc định kỳ dừng khi hết ngân sách lượt gọi và chạy lại ở giờ sau.
- Kênh hết hạn không làm hỏng các kênh khác.

## Xong khi

- `npx vitest run modules/social modules/kol modules/_lib` qua.
- Gỡ module `kol`, module `social` vẫn chạy.

## Ghi chú

- Các số này chỉ là của tài khoản shop đã nối. Số của kênh người khác thuộc về Dream 100 (T16).
- Thời gian xem trung bình chỉ có ở video Facebook.
