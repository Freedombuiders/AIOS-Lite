---
name: review-code
description: "Review thay đổi code theo thứ tự: lỗi đúng sai, bảo mật, test, rồi mới đến phong cách."
---

# Review code

Dùng khi được yêu cầu xem xét một thay đổi (diff, pull request hoặc vài file).

## Thứ tự xem xét

1. **Đúng sai:** logic có làm đúng điều mô tả không? Trường hợp biên, giá trị rỗng, lỗi mạng.
2. **Bảo mật:** dữ liệu từ ngoài có được kiểm tra không? Có lộ khoá, mật khẩu, đường dẫn không?
3. **Test:** thay đổi có test cho đường chính và đường lỗi không?
4. **Dễ đọc:** tên, độ dài hàm, chú thích thừa hoặc thiếu.

## Cách báo cáo

- Mỗi phát hiện ghi: file và dòng, vấn đề, cách sửa đề xuất.
- Phân loại: **Phải sửa** hoặc **Nên sửa**. Không chê phong cách cá nhân.
- Cuối cùng nêu một câu kết luận: có thể gộp, hoặc cần sửa trước.
