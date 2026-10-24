---
schema: aios-team/v1
name: FB Content Studio
slug: fb-content-studio
version: 1
description: Đội nội dung Facebook gồm một trưởng nhóm content (lên kế hoạch, viết bài vào hàng chờ duyệt, rà lịch đăng mỗi tuần) và một agent trực Fanpage trả lời bình luận.
manager: fb-content-lead
tags: [facebook, content, marketing, fanpage]
requiredSkills:
  - fb-content
  - fb-comment-reply
requiredIntegrations: []
prerequisites:
  - Đã kết nối ít nhất một Fanpage trong Marketing › Facebook, và Page đó đã có giọng thương hiệu cùng các trụ cột nội dung.
  - Sau khi cài, vào Marketing › Facebook › Bình luận, chọn agent "Trực Fanpage" làm người trả lời cho Page rồi bật chế độ nháp trước khi cho gửi tự động.
  - Bật agent trong Agents để lịch hằng tuần chạy.
inputs:
  - key: BRAND_NAME
    label: Tên thương hiệu
    description: Tên thương hiệu hoặc Fanpage, dùng trong chỉ dẫn của hai agent và trong lịch hằng tuần.
    kind: plain
    required: true
  - key: FOCUS_PAGE
    label: Fanpage ưu tiên
    description: Để trống nếu muốn rà mọi Page đang bật. Điền tên hoặc id Page (đúng như trong Marketing › Facebook) để chỉ rà một Page.
    kind: plain
    required: false
---

# FB Content Studio

Gói này dựng sẵn hai agent cho Fanpage trên Content Studio của AIOS-Lite. Cả hai đều làm việc qua công cụ có sẵn, không có đường tắt để đăng bài.

## Gồm những gì

- **Trưởng nhóm Content FB** (`fb-content-lead`): đọc Page và số liệu được cấp, viết bài kèm 3 hook và đẩy vào hàng chờ duyệt. Mọi bài do agent tạo đều chờ bạn duyệt; agent không đăng bài.
- **Trực Fanpage** (`fb-comment-agent`): trả lời bình luận công khai theo giọng thương hiệu, chuyển người thật khi gặp khiếu nại. Bạn gán agent này cho Page ở Marketing › Facebook › Bình luận.
- **Lịch rà soát hằng tuần** (thứ Hai 8:00, giờ Việt Nam): trưởng nhóm kiểm tra lịch đăng 7 ngày tới, tìm ngày trống hoặc trụ cột bị thiếu, soạn bài bù vào hàng chờ duyệt và gửi bạn báo cáo ngắn.

## Quyền và giới hạn

- Mặc định agent chạy ở chế độ an toàn, chưa có quyền nào. Để trưởng nhóm làm việc, cấp cho `fb-content-lead` module `marketing` với scope `content.write` (soạn, sửa, đề xuất giờ; không đăng) và thêm `analytics.read` nếu muốn dùng số liệu Page.
- Agent trực Fanpage cần scope `comments.reply` của module `marketing`; không cấp `publish` cho agent nào trong gói này.
- Agent trực Fanpage đọc nội dung của người lạ: persona dặn coi đó là dữ liệu, không phải chỉ dẫn.
- Cài xong lịch ở trạng thái tắt; bật lịch trong Lịch định kỳ sau khi cấp quyền.
