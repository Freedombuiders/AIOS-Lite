# Talking-head Quyên: Pexels tách nền trên đầu

Áp dụng khi `styleId: "quyen"` (`/edit-video-talking-head`). Nguồn: skill `quyen-raw-video-edit` và video mẫu do chủ kênh cung cấp. Bản mẫu là hướng thể hiện; mỗi footage mới cần transcript, điểm cắt và ảnh riêng.

1. Xem metadata và khung thật trước khi xoay hay reframe. Giữ người nói giữa khung dọc 9:16, giọng gốc 1×. Không ép độ dài theo video mẫu.
2. Đọc transcript có mốc từng từ. Bỏ đếm máy, take nói hụt hoặc nói lại, từ đệm vô nghĩa và nghỉ thừa; giữ hơi thở, câu phủ định và ý nghĩa. Kiểm tra bằng nghe/xem ở điểm cắt nghi ngờ. Phụ đề chỉ chứa lời còn lại sau cắt.
3. B-roll chỉ dùng ảnh **Pexels** đúng vật thể đang được nhắc tới. Lưu ID ảnh, URL và tác giả trong metadata của tài sản. Xem ảnh gốc, tách nền thành PNG có alpha thật rồi thêm cả ảnh gốc và PNG vào kho. Không tạo vật thể mới thay ảnh Pexels. Nếu thiếu kết nối Pexels hoặc chưa có ảnh tách nền, ghi rõ việc cần bổ sung; không gọi video xuất thiếu ảnh là hoàn chỉnh.
4. Trong plan, mỗi vật thể là `brolls[]` với `source: "pexels"`, `layout: "cutout"`, `assetId` trỏ tới PNG alpha, `anchorWord` đúng từ khoá, `reason` nêu lời được minh hoạ. Dùng `box: {x,y,w,h}` theo phần trăm khung để tránh đầu, mặt và tay. Điểm xuất phát cho video dọc: `{x:18.5,y:2.6,w:63,h:25}`; điều chỉnh theo footage. Một vật thể/cụm cho mỗi ý. Không có card, nền chữ nhật, viền hoặc nhãn trên ảnh.
5. Ảnh vào nhẹ khoảng 0,16 giây, hiện sát từ khoá rồi giữ tới khi đổi ý. Phụ đề trắng viền tối, từ khoá vàng, tối đa hai dòng ở vùng ngực (xấp xỉ y 72–80%). Kiểm tra dấu tiếng Việt và vùng an toàn. Hook/CTA chỉ dùng nội dung có thật trong footage. Mặc định không thêm nhạc, giọng luôn rõ.
6. Soát preview ở đầu, giữa, cuối và mọi lúc ảnh xuất hiện: ảnh đúng ý và không che mặt/tay; không còn khung nền; môi/tiếng khớp; phụ đề khớp âm thanh. Nếu PNG thiếu alpha, renderer chặn bản xuất.

Việc tìm Pexels và tách nền là khâu chuẩn bị tài sản; renderer chỉ nhận PNG đã tách nền từ kho và không tự gọi dịch vụ tạo ảnh.
