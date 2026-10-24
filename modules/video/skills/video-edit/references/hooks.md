# Hook: 3 giây đầu quyết định người xem ở lại hay lướt

Mỗi plan có `hook.options` gồm **3 phương án khác kiểu nhau** (không phải 3 cách viết lại một câu) và `hook.chosen` là phương án bạn đề xuất. Chủ kênh đổi sang phương án khác trong tab Hook mà không cần gọi bạn, nên cả 3 phải dùng được.

## Ba phương án

| Phương án | `mode` | Là gì | Khi nào hợp |
|---|---|---|---|
| **A. Câu gốc** | `overlay` | Giữ nguyên phần mở đầu người nói, thêm chữ lớn nhắc lại ý của chính câu đó trong khoảng 2 giây đầu | Người nói mở đầu đã tốt (câu hỏi, con số, tuyên bố mạnh). Giữ chất thật, ít can thiệp nhất |
| **B. Chữ do đạo diễn viết** | `overlay` | Chữ hook mới, ngắn, gắt hơn đoạn mở đầu gốc, đặt trên đúng phần mở đầu gốc | Mở đầu gốc là lời chào, "ok các bạn", dẫn dắt dài mà ý hay nằm ở sau |
| **C. Đưa đoạn hay lên đầu** | `moved` | Phát trước đoạn `moveFromWord..moveToWord` (một câu gây tò mò hoặc kết quả bất ngờ), rồi mới vào video từ đầu | Trong video có một câu "đắt" (con số, kết luận, câu chuyện) nằm giữa hoặc cuối |

`kind` mô tả kiểu chữ hook: `question` (câu hỏi gây tò mò), `warning` (cảnh báo, "đừng làm...", "sai lầm"), `number` (con số cụ thể), `story` (câu chuyện, "tôi từng..."), `other`. Ba phương án nên có ít nhất hai `kind` khác nhau.

## Viết chữ hook (A và B)

- Tối đa khoảng 7 đến 9 từ. Đọc hết trong 1,5 đến 2 giây.
- Cụ thể thắng chung chung: con số, tên, kết quả. "Giảm 50% thời gian dựng" hơn "Mẹo dựng video hay".
- Chỉ nói điều **video thật sự trả lời**. Không câu giật tít rồi không giao. Không bịa số.
- `text` là dòng lớn, `subtext` là dòng nhỏ dẫn (tuỳ chọn, không quá 40 ký tự). Hợp với hiệu ứng `two-tier-title`.
- Từ cần giữ nguyên của hồ sơ kênh xuất hiện thì giữ đúng chữ.
- Theo `taste` và phong cách: kênh cấm chữ đỏ, cấm câu hỏi... thì hook cũng cấm.

## Chọn đoạn đưa lên đầu (C)

1. Quét `transcript --plain --indexed` tìm câu thoả **cả ba**: (a) tự đứng được, nghe một mình vẫn hiểu; (b) gây tò mò hoặc là kết quả; (c) dài **3 đến 6 giây** (từ `start` của từ đầu đến `end` của từ cuối, đúng bằng `words[moveToWord].end - words[moveFromWord].start`).
2. Bắt đầu ở đầu câu, kết thúc ở cuối câu. Không cắt giữa mệnh đề; không để đoạn bắt đầu bằng "và", "nhưng", "cho nên" (cần ngữ cảnh).
3. Đoạn được **chuyển** lên đầu (không lặp lại): máy phát nó trước, và chỗ cũ trong video không còn đoạn đó. Vì vậy **đọc lại lời sau khi chuyển**: phần còn lại phải vẫn xuôi, không thiếu ý nối, không còn câu tham chiếu tới điều vừa bị lấy đi ("như tôi nói", "con số này"). Nếu mạch bị hụt thì chọn đoạn khác hoặc đổi sang phương án B.
4. Đoạn không nên nằm trong `cutWords` (validate cảnh báo): từ đã bị cắt thì bỏ khỏi `cutWords` nếu muốn nó phát ở đầu.
5. Nếu đoạn mở đầu gốc cũng đã là một câu hook mạnh, phương án A thường tốt hơn C.

## Chọn `chosen`

- Mở đầu gốc đã mạnh: chọn A.
- Mở đầu gốc yếu và video có câu "đắt": chọn C nếu đoạn ngắn và tự đứng được, ngược lại B.
- Phong cách đòi hook gắt (`/congnghe`, `/review`, `/sanpham`): nghiêng B hoặc C, ưu tiên `number` và `warning`.
- Phong cách chậm, đời thường (`/giaoduc`, `/tamsu`, `/vlog`): nghiêng A, hook mềm; đừng giật tít.
- Có bài học riêng của kênh về hook: bài đó thắng quy tắc chung ở đây.

Ghi lý do chọn vào dòng bằng chứng: `log effects "hook: chọn B (number) vì mở đầu gốc là lời chào; A và C đã soạn sẵn cho chủ kênh"`.
