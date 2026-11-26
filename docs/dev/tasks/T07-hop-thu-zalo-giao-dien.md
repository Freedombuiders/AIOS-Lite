# T07 · Giao diện Hộp thư Zalo

> Nhánh Chăm khách · 3 ngày · Phụ thuộc: T06, T10 · Kế hoạch mục 5.2.2

## Mục tiêu

Một màn ba cột: danh sách cuộc chat, lịch sử và ô nhắn, bảng gán bot. Chủ shop xem, tự nhắn và điều khiển bot mà không rời màn.

## Bản vẽ tham chiếu

`docs/dev/design-mockups/Inbox.dc.html`.

## File đụng tới

Sửa trang hộp thư sẵn có của `care` (`modules/care/web/`, route `/m/care/inbox[/:id]`), không viết trang mới song song. Thêm thành phần `BotPanel`. Dùng `care.channelPanel` → `ZaloChannelPanel` sẵn có cho phần riêng của Zalo.

## Các bước

- [ ] Cột trái: bộ chọn nick kèm trạng thái kết nối và số tin đã gửi trên trần (API `usage` của T05); ô tìm; ba bộ lọc Tất cả, Chưa đọc, Chưa trả lời; danh sách cuộc chat.
- [ ] Mỗi dòng có một nhãn trạng thái do máy chủ tính, không tính ở giao diện: Chờ bạn duyệt (có nháp `status='draft'`), Bot đang chăm (`mode='auto'` hoặc `'draft'` và không tạm dừng), Bot nhường bạn (đang trong cửa sổ tạm dừng sau khi người nhắn), Chưa gán bot. Thêm trường này vào API danh sách cuộc chat.
- [ ] Cột giữa: lịch sử tin, phân biệt bốn loại người gửi theo `sender_role` (`customer`, `self`, `operator`, `agent`). Tin `self` gửi từ điện thoại ghi rõ "gửi ngoài app".
- [ ] Tải thêm tin cũ khi cuộn lên; tin mới tới qua SSE (`useEvents`), không hỏi vòng.
- [ ] Nháp của bot hiện ngay trên ô nhắn, kèm lý do dừng và nguồn brain, với ba nút Gửi, Sửa rồi gửi, Bỏ. Gọi các đường sẵn có ở `api/routes-drafts.ts`.
- [ ] Ô nhắn: chữ, ảnh và file (T06), chèn mẫu câu bằng phím `/`, nút "Nhờ bot soạn" gọi `POST /conversations/:id/draft`.
- [ ] Cột phải, `BotPanel`: chọn bot (agent đang bật có scope `care: reply.send`), phạm vi (cả nick hay riêng cuộc chat này), ba chế độ, ba nút tạm dừng, danh sách luật đang áp dụng đọc từ cài đặt thật, và nhật ký lượt chạy của cuộc chat (`care_agent_runs`, kèm `skip_reason` đã dịch sang lời).
- [ ] Mọi thay đổi chế độ hiện một dòng báo có nút Hoàn tác trong 5 giây.
- [ ] Cuộc chat nhóm: chỉ xem lịch sử. Ẩn `BotPanel`, ghi "bot không trả lời trong nhóm".
- [ ] Trang này khai `hideCommandBar` (T10).

## Test

- Test thành phần: dòng có nháp hiện nhãn Chờ bạn duyệt; đổi chế độ gọi đúng đường API; `skip_reason` nào cũng có lời dịch (test liệt kê hết giá trị trong code).
- Một kịch bản Playwright trong `e2e/` với connector giả: tin đến, nháp hiện, bấm Gửi, tin xuất hiện bên phải.

## Xong khi

- Kịch bản e2e xanh.
- Ở bề ngang điện thoại: ba cột thành ba màn chồng, mở một cuộc chat thì chiếm cả màn.

## Ghi chú

Các trang khác của `care` (`/drafts`, `/customers`, `/followups`, `/channels`, `/rules`, `/activity`) giữ nguyên, gom vào một menu phụ. `/customers` sẽ được thay ở T09.
