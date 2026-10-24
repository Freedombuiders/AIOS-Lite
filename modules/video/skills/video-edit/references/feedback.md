# Góp ý của chủ kênh thành luật ngắn

Sau khi giao video, chủ kênh nói gì về video là dữ liệu quý nhất. Biến nó thành **luật ngắn, cụ thể, kiểm được** gắn vào hồ sơ kênh, để lần sau không phải nhắc lại. Luật nằm trong `profile.taste` (Markdown); mỗi lượt dựng đều đọc nó trước, và nó là **luật cứng**.

Cách ghi: khối ```json `{"rule": "<một câu>"}` (tối đa 400 ký tự, nối vào cuối `taste`).

## Ba nút trả lời nhanh sau khi giao

Hệ thống đã tự xử lý các nút này; bạn chỉ gặp lại kết quả trong ngữ cảnh:

| Nút | Ý nghĩa | Việc của bạn |
|---|---|---|
| "Ổn, đóng được" | video đạt | không làm gì thêm. Nếu có gì bạn tự thấy đáng nhớ thì thôi, đừng bịa luật |
| "Có chỗ muốn sửa" | mở ô góp ý | chờ góp ý cụ thể, rồi làm theo mục "Góp ý theo giây" dưới đây |
| "Hiệu ứng hơi nhiều" | giảm hiệu ứng | giảm hiệu ứng ở bản sửa và ghi luật mật độ (xem mẫu) |

## Góp ý theo giây

Chủ kênh có thể góp ý dạng: **video + giây + đổi gì**, ví dụ "bản 2, giây 17: chữ 3 NĂM nhỏ lại". Quy trình:

1. Đổi giây (của video đã dựng, bản plan nào đó) sang vị trí trong lời chép nếu cần (`plan show`, `transcript`).
2. Sửa plan, ghi `changes` (hoặc `[mark:<id>]` nếu là điểm ghim).
3. Quyết định đó là **việc riêng một lần** hay **sở thích lâu dài**:
   - Chỉ video này ("bỏ câu chào ở giây 2") → chỉ sửa plan, **không** ghi luật.
   - Sở thích lặp lại (chữ nhỏ hơn, ít hiệu ứng, nhịp chậm) → ghi luật.
   - Không chắc: hỏi một câu "mình ghi luật này cho cả kênh nhé?", rồi mới ghi.

## Viết luật thế nào

Một luật tốt: **ngắn, có hành động cụ thể, có phạm vi, không mâu thuẫn luật cũ**.

Mẫu tốt:
- `Chữ nhấn kiểu số (3 NĂM, 50%) cỡ nhỏ hơn 20% so với mặc định; không viết hoa toàn bộ.`
- `Tối đa 2 hiệu ứng chữ mỗi 10 giây; bỏ zoom nếu đã có hiệu ứng ở cùng câu.`
- `Không dùng nhạc buồn hoặc nhạc có lời; ưu tiên mood "Tập trung" và "Tươi sáng".`
- `Giữ nguyên lời chào đầu video, không cắt trước 3 giây đầu của clip.`
- `Hook dạng câu hỏi ngắn dưới 7 từ; không dùng dấu chấm than.`

Mẫu xấu: "làm đẹp hơn", "chuyên nghiệp hơn" (không kiểm được); "lần này chữ to lên" (chỉ của một video); luật dài một đoạn văn.

Trước khi ghi:
- Đọc `taste` hiện có (`project show`). Luật mới trùng ý một luật cũ thì không ghi lại; mâu thuẫn luật cũ thì **hỏi chủ kênh** luật nào thắng.
- Không ghi thông tin cá nhân của người xem hay khách hàng.
- Không ghi luật về `keepWords` (tên sản phẩm là thiết lập hồ sơ, không phải gu).

## Luật hay bài học?

- **Luật** (`profile rule`): ngắn, của riêng kênh, mọi lượt dựng đọc. Vào `taste`.
- **Bài học** (`lessons add`): giải thích dài hơn một vấn đề dựng ("vì sao hook câu hỏi hợp kênh này"), có ví dụ. Vào vault `Video Studio/Kenh/<kênh>/bai-hoc/`. Chỉ viết khi bạn rút ra được điều **mới và dùng lại được**; bài học chung cho mọi kênh (`--shared`) cần chủ kênh hoặc quản trị đồng ý, vì bạn thường không có quyền ghi vào thư mục chung.

## Trả lời chủ kênh

Sau khi sửa và (nếu cần) ghi luật, nói gọn: đã đổi gì (kèm giây), và nếu đã ghi luật thì nhắc đúng nguyên văn luật để họ sửa nếu chưa đúng ý. Ví dụ: "Mình đã thu nhỏ chữ '3 NĂM' ở giây 17 và ghi luật cho kênh: 'Chữ nhấn kiểu số cỡ nhỏ hơn 20%...'. Chưa đúng ý thì nói mình sửa."
