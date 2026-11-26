# T26 · Thử nghiệm kỹ thuật cho Gọi trợ lý

> Nhánh Cuối · 3 ngày · Phụ thuộc: không · Kế hoạch mục 5.8

## Mục tiêu

Trả lời bằng số đo thật: có nên làm chế độ nói realtime không, và bằng model nào. Sản phẩm của task là một báo cáo và một bản chạy thử bỏ đi, không phải tính năng.

## Ba câu phải trả lời

1. Model nào nghe và nói tiếng Việt đủ tốt, kể cả tên sản phẩm ("ô long sen", "trà sen Tây Hồ"), tên người, và số tiền ("mười bốn triệu ba trăm năm mươi hai nghìn")?
2. Độ trễ từ lúc ngừng nói tới lúc nghe tiếng trả lời là bao nhiêu, đo trên mạng ở Việt Nam?
3. Một phút gọi tốn bao nhiêu?

## Các bước

- [ ] Chọn 2 đến 3 model nói realtime đang có. Ghi rõ tên, phiên bản và ngày thử. Tra tài liệu hiện hành của từng nhà cung cấp; đừng dựa vào trí nhớ về tên model hay giá.
- [ ] Viết một trang thử tối thiểu trong `spikes/voice/` (không nối vào app): trình duyệt nối tới model bằng khoá tạm do một máy chủ cục bộ cấp.
- [ ] Soạn bộ 20 câu thử tiếng Việt cố định trong `spikes/voice/cau-thu.md`: 5 câu hỏi số liệu, 5 câu có tên sản phẩm và tên người, 5 câu có số tiền, 5 câu ra lệnh ("mở hộp thư", "giao Bot Nội dung viết bài về giá sỉ").
- [ ] Với mỗi model, chạy cả bộ, ghi lại: nghe đúng hay sai (chép lại nguyên văn model hiểu), nói có tự nhiên không, độ trễ từng câu.
- [ ] Thử gọi công cụ: cho model một công cụ `doc_hom_nay()` trả dữ liệu mẫu, xem nó gọi đúng lúc không và đọc số có đúng không.
- [ ] Thử ngắt lời: nói chen khi model đang nói.
- [ ] Thử nghe nhầm lệnh nguy hiểm: nói 10 câu gần giống "gửi đi" ("gửi đi đâu", "đừng gửi đi", "để mai gửi"). Đếm số lần model hiểu thành lệnh gửi.
- [ ] Tính chi phí một phút từ số liệu sử dụng thật của các lượt thử.

## Sản phẩm

`docs/dev/VOICE-SPIKE.md` gồm:

- Bảng kết quả theo model: tỷ lệ nghe đúng trên 20 câu, độ trễ trung vị và tệ nhất, chi phí một phút.
- Kết quả thử nghe nhầm lệnh gửi.
- Khuyến nghị: làm hay không làm; nếu làm thì model nào, và mặc định là bấm để nói hay luôn nghe.
- Những gì chưa thử được và vì sao.

## Xong khi

Có báo cáo với đủ ba con số cho ít nhất hai model, đo thật, kèm ngày đo. Không có con số nào là ước lượng mà không ghi rõ là ước lượng.

## Ghi chú

- Thiết kế dự kiến ở mục 5.8.2 của kế hoạch không có công cụ gửi: lời "gửi đi" chỉ làm nút Gửi sáng lên. Kết quả thử nghe nhầm sẽ cho biết quyết định đó có cần giữ không.
- Thư mục `spikes/` không vào bản phát hành.
- `freedom_os` có một bản "War Room" làm việc tương tự. Giấy phép của nó không cho chép; chỉ đọc để biết họ đã gặp vấn đề gì.
