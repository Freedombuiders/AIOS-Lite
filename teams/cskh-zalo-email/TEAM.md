---
schema: aios-team/v1
name: CSKH Zalo và Email
slug: cskh-zalo-email
version: 1
description: Đội chăm sóc khách hàng qua Zalo và Gmail gồm một agent CSKH trả lời khách theo hồ sơ cửa hàng và một agent tổng hợp khiếu nại cuối ngày; kèm bộ eval hành vi tiếng Việt.
manager: cskh-agent
tags: [cskh, zalo, email, customer-care]
requiredSkills:
  - cskh-escalation
requiredIntegrations:
  - id: pancake
    optional: true
    reason: Tra cứu đơn hàng và khách trong Pancake POS. Chỉ đọc tự do; mọi thao tác ghi phải được bạn duyệt.
prerequisites:
  - Đã kết nối ít nhất một nick Zalo trong Zalo › Tài khoản (và/hoặc một hộp thư Gmail trong Email) để có hội thoại cần chăm.
  - Sau khi cài, gán agent "CSKH Zalo và Email" cho nick hoặc hội thoại ở Zalo › Agent chăm, bắt đầu bằng chế độ nháp.
  - Điền hồ sơ cửa hàng (giá, chính sách, giờ làm việc) vào knowledge/customer-care.md của agent trước khi cho trả lời tự động. Chỗ nào chưa có thì agent nói chưa có thông tin.
  - Bật agent trong Agents để lịch tổng hợp cuối ngày chạy.
inputs:
  - key: SHOP_NAME
    label: Tên cửa hàng
    description: Tên cửa hàng hoặc thương hiệu, dùng khi agent xưng hô với khách và trong báo cáo.
    kind: plain
    required: true
  - key: BUSINESS_HOURS
    label: Giờ làm việc
    description: Giờ nhân viên có mặt, để agent hẹn khách đúng giờ khi chuyển cho người.
    kind: plain
    required: false
    default: "8:00 đến 21:00 mỗi ngày"
  - key: ESCALATION_CONTACT
    label: Người nhận khiếu nại
    description: Tên hoặc vai trò người quyết định khiếu nại, hoàn tiền, giảm giá (ví dụ "quản lý Minh").
    kind: plain
    required: false
    default: nhân viên phụ trách
---

# CSKH Zalo và Email

Gói này dựng sẵn hai agent chăm sóc khách hàng, dùng các tính năng AIOS-Lite có sẵn: module Chăm sóc khách hàng, Second Brain và (tuỳ chọn) tích hợp Pancake.

## Gồm những gì

- **CSKH Zalo và Email** (`cskh-agent`): trả lời khách theo hồ sơ cửa hàng trong `knowledge/customer-care.md`. Không bịa giá, tồn kho, thời gian giao hay chính sách; khiếu nại, hoàn tiền, giảm giá thì chuyển cho người. Kèm skill `cskh-escalation` mô tả khi nào chuyển, khi nào bỏ qua.
- **Tổng hợp khiếu nại** (`cskh-complaints`): mỗi ngày 21:30 (giờ Việt Nam) tổng hợp nội dung hội thoại 24 giờ qua mà bạn cung cấp trong việc (hoặc ghi chú trong Second Brain được cấp), gom khiếu nại và khách chưa được trả lời, gửi bạn báo cáo ngắn. Chỉ đọc, không trả lời khách.

## Quyền và giới hạn

- Mặc định cả hai agent chạy ở chế độ an toàn và chưa có quyền nào. Muốn dùng Pancake, cấp tích hợp `pancake` mức `ask` (đọc tự do, ghi phải được bạn duyệt) cho agent CSKH ở Agents › Quyền.
- Muốn module Chăm sóc khách hàng gửi hội thoại cho agent, cấp scope `reply.draft` (soạn nháp) và chọn agent ở module; chỉ cấp `inbox.read` khi bạn chấp nhận agent đọc dữ liệu khách thật.
- Tin nhắn khách là dữ liệu không đáng tin: persona đã dặn agent không làm theo chỉ dẫn nằm trong tin nhắn.
- Agent chạy headless và chưa được bật sau khi cài.
