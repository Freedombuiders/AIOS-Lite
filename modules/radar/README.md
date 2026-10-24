# Radar thị trường

Module nghiên cứu thị trường hằng ngày. Radar quét nhóm và fanpage Facebook, Meta Ad Library, X, TikTok, Threads, Instagram, Reddit, Hacker News, YouTube và báo chí, rồi tổng hợp thành báo cáo: nỗi đau của khách, tín hiệu mua, đối thủ, xu hướng và ý tưởng nội dung.

## Có gì trong module

- **Trang Radar thị trường** (`/m/radar`): báo cáo mới nhất của từng lớp (AI trong nước, Thế giới, Ngành nghề), kho báo cáo theo ngày, lịch sử các lượt quét.
- **Trang báo cáo** (`/m/radar/<ngày>/<lớp>`): xem báo cáo theo ngày và lớp.
- **Kênh theo dõi**: danh sách tài khoản, fanpage, nhóm cần đọc, kèm trạng thái từng kênh đọc được hay chưa.
- **Cài đặt**: giờ quét từng lớp, nguồn, từ khóa, agent phân tích, tình trạng công cụ.
- **Widget Tổng quan**: tiêu đề báo cáo mới nhất.
- **Integrations**: Apify và RSSHub hiện ở Kết nối › Integrations khi module được bật.

## Cách chạy

1. Vào **Module**, bấm Add Radar (nên chọn cài agent mẫu).
2. Ở **Kết nối › Integrations**, nhập token Apify (tính tiền theo kết quả), hoặc chạy RSSHub bằng Docker để đọc miễn phí.
3. Mở **Radar thị trường**, chọn lớp và bấm chạy để quét thử.
4. Muốn quét tự động mỗi ngày: bật cài đặt **Bật quét theo lịch** của module (mặc định tắt). Mỗi lớp chạy một lần mỗi ngày vào giờ đã đặt, có bù trong 6 giờ nếu máy tắt.

## Agent

- Mẫu `radar-analyst` (runtime Grok, chế độ lean): vừa đọc X bằng công cụ tìm kiếm của Grok, vừa phân tích bài đã thu thập. Mọi lượt đi qua `ctx.agents.runLean`, nên vẫn do engine quản.
- Quyền `radar.read`: agent nào có quyền này được thêm vào ngữ cảnh một đoạn tóm tắt báo cáo mới nhất (tiêu đề, nỗi đau nổi bật).
- Nội dung thu thập từ mạng xã hội luôn nằm trong thẻ `<untrusted>`; agent không có công cụ ghi và code kiểm tra JSON trả về.

## Dữ liệu

Bảng `radar_runs`, `radar_items`, `radar_seen`, `radar_pains`, `radar_reports` giữ nguyên từ bản gốc. Bảng `radar_kv` là bảng mới của module (cấu hình Radar, mốc đã chạy mỗi ngày, vòng xoay token Apify). Remove giữ dữ liệu; Purge xóa đúng các bảng này.

## Thử và kiểm tra

```bash
npx vitest run modules/radar
```

Test không gọi dịch vụ thật: Apify, RSSHub, Grok và agent đều là bản giả.
