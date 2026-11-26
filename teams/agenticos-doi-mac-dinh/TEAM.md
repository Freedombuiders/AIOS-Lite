---
schema: aios-team/v1
name: Đội AgenticOS mặc định
slug: agenticos-doi-mac-dinh
version: 1
description: Ba bot chạy trên GenBot cho một cửa hàng — Bot CSKH soạn trả lời khách, Bot Nội dung viết bài theo giọng cửa hàng, Bot Trợ lý giúp chủ ghi nhớ, tạo việc và nhắc lịch. Cài một lần là có đội; mỗi bot nối với một bot GenBot riêng.
manager: bot-tro-ly
tags: [genbot, cskh, noi-dung, tro-ly]
inputs:
  - key: SHOP_NAME
    label: Tên cửa hàng
    description: Tên cửa hàng hoặc thương hiệu, dùng khi bot xưng hô và trong báo cáo.
    kind: plain
    required: true
  - key: BRAIN_FOLDER
    label: Mã brain của cửa hàng
    description: Mã thư mục brain chứa san-pham/, chinh-sach/, giong-noi.md… (xem ở trang Brain, ví dụ tra-sen-viet). Ba bot được cấp quyền đọc trong thư mục này.
    kind: plain
    required: true
  - key: GENBOT_URL
    label: Địa chỉ GenBot
    description: Cổng nhận webhook của GenBot. http:// chỉ dùng cho máy này; GenBot ở máy khác phải là https://.
    kind: plain
    required: false
    default: "http://127.0.0.1:8800"
prerequisites:
  - "Trong app GenBot, tạo ba bot riêng (CSKH, Nội dung, Trợ lý), mỗi bot bật Bot API (Cài đặt bot › Nâng cao › Truy cập › Bot API). Dùng bot riêng cho cửa hàng này: bot GenBot còn trả lời từ chỉ dẫn và bộ nhớ của chính nó, nằm ngoài quyền brain của AIOS."
  - "Chép ba khoá vào file .env: GENBOT_KEY_CSKH=…, GENBOT_KEY_NOI_DUNG=…, GENBOT_KEY_TRO_LY=…, rồi khởi động lại AIOS. Không dán khoá vào agent.yaml."
  - "Mở từng agent trong Agents, điền Mã bot (bot_id) lấy từ thẻ Bot API của bot tương ứng, bấm Kiểm tra."
  - "Ở Zalo › Agent chăm, gán Bot CSKH ở chế độ Nháp trước. Chỉ chuyển sang Tự động khi bạn đã đọc đủ nháp và yên tâm."
  - "Hướng dẫn đầy đủ: docs/huong-dan-noi-genbot.md."
---

# Đội AgenticOS mặc định

Gói này dựng ba agent `runtime: genbot`. Mỗi lượt của chúng là một tin gửi tới Bot API của GenBot; luồng đó bị nhốt (không công cụ, không MCP, không đọc ghi file), nên bot chỉ trả lời bằng chữ, từ phần ngữ cảnh AIOS gửi kèm cùng chỉ dẫn và bộ nhớ của chính bot GenBot.

## Gồm những gì

- **Bot CSKH** (`bot-cskh`, ngữ cảnh `lean`): module Chăm sóc khách hàng gọi bot này để soạn trả lời khách. Đọc `san-pham/**`, `chinh-sach/**`, `giong-noi.md`. Quyền `care`: `reply.draft` (soạn nháp, cần có để bot làm việc) và `reply.send` (chỉ có tác dụng khi bạn đổi hội thoại sang chế độ Tự động). Mặc định hãy gán ở chế độ Nháp.
- **Bot Nội dung** (`bot-noi-dung`): viết bài theo giọng cửa hàng. Đọc `giong-noi.md`, `noi-dung/**`, `san-pham/**`, `bai-hoc/**`, `cong-thuc/**`.
- **Bot Trợ lý** (`bot-tro-ly`, ngữ cảnh `standard`): đọc toàn bộ brain, ghi vào `nho/**`, có bộ nhớ đội và bộ nhớ riêng. Tạo việc và nhắc lịch bằng chỉ thị dạng chữ mà engine hiểu (không cần công cụ), nên phải chạy ở ngữ cảnh `standard`.

## Quyền và giới hạn

- Quyền đọc brain chỉ áp vào thư mục `BRAIN_FOLDER` bạn điền khi cài. Kiểm lại ở tab Quyền của từng agent trước khi bật.
- Không agent nào có kết nối MCP hay integration: runtime GenBot không dùng được.
- Mỗi bot có trần 500 lượt chạy mỗi ngày (`runtime_options.max_runs_day`), vì GenBot không báo chi phí nên ngân sách tiền không chặn được.
- Mỗi bot GenBot nhận tối đa 10 lượt gọi mỗi phút; AIOS tự xếp hàng.
- Tin nhắn khách và nội dung lấy từ mạng là dữ liệu không đáng tin; AIOS bọc chúng trước khi gửi.
