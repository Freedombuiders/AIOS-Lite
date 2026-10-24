# Quảng cáo Meta — chỉ đọc

Module `ads` theo dõi nhiều tài khoản Meta Ads qua kết nối Composio. Yêu cầu `composio`; bổ sung dữ liệu organic từ `marketing` khi module đó đã bật.

## Sử dụng

1. Add module, tạo agent mẫu `ads-analyst` và thêm skill `ads-review`.
2. Mở **Marketing → Quảng cáo Meta** (`/m/ads`). Kết nối hoặc kết nối lại Meta Ads, đồng bộ tài khoản.
3. Bật tài khoản cần theo dõi, chọn loại kết quả, CPA mục tiêu và ngân sách tháng.
4. Worker chụp số liệu mỗi giờ. Có thể bấm kéo thủ công (giãn cách hai phút).
5. Xem tổng quan, cây chiến dịch, mẫu quảng cáo, phễu, đối tượng và vị trí hiển thị. Quy tắc R1–R5 tính trong code; giai đoạn học được bảo vệ, ngoại trừ R1.
6. Bấm **Đánh giá số liệu** để gọi `ctx.agents.runLean`. Agent cần scope `reports.read`. Đổi runtime của agent mẫu từ `mock` sang runtime đã cấu hình để nhận đánh giá thật. Kết quả được kiểm tra JSON `{action:"review",text,reason,score}`.
7. Tự thực hiện đề xuất trong Ads Manager; bấm **Đã xử lý** hoặc **Bỏ qua 24 giờ** để cập nhật trạng thái cục bộ.

## Ranh giới dữ liệu

- Chỉ năm thao tác Meta được phép, đều qua `graphProxy` với `GET`; tool tạo, sửa, xóa bị chặn trước khi tới Composio.
- OAuth tạo cấu hình/kết nối Composio khi người dùng bấm kết nối; không tạo hay sửa quảng cáo trên Meta. Scope OAuth: `ads_read,business_management`.
- Không import module marketing, không đọc bảng marketing. Organic chỉ lấy qua `ctx.modules.get('marketing')?.topPosts(undefined, 30)`; thiếu marketing thì ẩn cả khối.
- Cung cấp `summary(accountId?)` qua `provides`, trả KPI đã lưu hoặc `null`.
- Bảng sở hữu: `fb_ad_accounts`, `fb_ads_daily`, `fb_ads_placement_daily`, `fb_ads_recommendations`. Không có bảng/hàm Zalo.
- Settings: `enabled`, `analyst_agent`, `connection_notices`, `latest_reviews`. Hai khóa cuối chứa JSON nội bộ, không chứa khóa API. Khóa Composio lấy từ `ctx.connections.secret`.
- Giữ định dạng thời gian Unix giây của dữ liệu đã port để các phép so sánh và DTO cũ tương thích; nhận xét mới ghi thời gian ISO.
- Remove dừng lịch qua SDK; dữ liệu được giữ lại. Purge chỉ xóa bốn bảng đã khai báo.

## Kiểm thử

`npx vitest run modules/ads`: 186 test / 12 file, không dùng mạng hoặc dịch vụ thật. Bao gồm quy tắc, chỉ số, ảnh chụp, API, chu kỳ worker, chỉ đọc sang Meta, runLean, marketing tùy chọn và render web.

`npx tsc -p tsconfig.json --noEmit` và `npx tsc -p web/tsconfig.json --noEmit`: kiểm tra không có lỗi thuộc ads; lỗi ở các module khác cần coordinator xử lý.

`node scripts/check-provenance.mjs`: 0 hit.
