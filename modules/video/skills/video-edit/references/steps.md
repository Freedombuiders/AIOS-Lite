# 12 bước của phiếu dựng, và phần của đạo diễn

Phiếu dựng có 12 bước (khoá `StepKey`). Máy làm 9 bước, bạn làm bước `direct` (và quyết định cho `effects`, `audio`, `cover`), chủ kênh làm `approve` và `deliver`. Mỗi bước hiện **dòng bằng chứng** (giờ + số liệu) dưới tên bước; chủ kênh đọc những dòng đó để tin việc đã làm thật.

| # | Khoá | Ai | Việc | Bạn ghi bằng chứng bằng |
|---|---|---|---|---|
| 1 | ingest | máy | probe, chuẩn hoá 1080p, bản xem nhẹ | (máy tự ghi) |
| 2 | transcribe | máy | whisper tiếng Việt, mốc từng từ, từ cần giữ vào `--prompt` | (máy) |
| 3 | analyze | máy | chỗ lặng, từ đệm, câu nói lại, đổi cảnh, khung hình, âm lượng | (máy) |
| 4 | direct | **bạn** | nạp não, đọc, biên kịch, cắt, dựng plan, tự kiểm | `log direct "..."` |
| 5 | approve | chủ kênh | duyệt kế hoạch (thẻ Cần tôi hoặc nút trong phiếu) | (hệ thống) |
| 6 | cut | máy | mỗi đoạn giữ là một clip, fade 30ms | (máy) |
| 7 | captions | máy | phụ đề tô từ khoá | (máy) |
| 8 | effects | bạn quyết, máy dựng | hook, hiệu ứng chữ, B-roll | `log effects "..."` |
| 9 | audio | bạn quyết, máy dựng | nhạc, SFX, mức âm | `log audio "..."` |
| 10 | render | máy | xuất MP4, chụp 6 khung để soát | (máy) |
| 11 | cover | bạn quyết, máy dựng | 3 ảnh bìa | `log cover "..."` |
| 12 | deliver | chủ kênh | tải về, chép vào thư mục giao | (hệ thống) |

## Bước 4 `direct`: các chặng của bạn

Mỗi chặng kết thúc bằng một dòng `log`. Không ghi dòng nào bạn chưa làm.

### D1. Nạp não
- `project show`: hồ sơ kênh (`taste` là luật cứng, `keepWords`, mức âm), phong cách, `brief`, plan hiện có, góp ý mở.
- `lessons search "<tên phong cách> <mục tiêu>"`, rồi vài truy vấn riêng: `hook`, `nhịp cắt`, `phụ đề`, `B-roll`, `ảnh bìa`. Lấy tối đa 3 đến 5 bài đúng vấn đề; bài riêng kênh thắng bài chung khi mâu thuẫn.
- Bằng chứng: `log direct "nạp não: hồ sơ <tên>, <n> luật gu, bài đã tra: <tên bài 1>, <tên bài 2>"`

### D2. Đọc video (lời, hình, rung)
- `transcript --plain --indexed`: đọc **cả** bài một lần trước khi cắt bất cứ thứ gì.
- `analysis`: danh sách chỗ lặng, từ đệm, câu nói lại (đó là gợi ý, không phải quyết định).
- Khung hình: nhìn các ảnh đính kèm (mở đầu, chỗ người nói đổi tư thế, chỗ đổi cảnh trong `analysis.scenes`, đoạn ứng viên làm bìa).
- Bằng chứng: `log direct "đọc <N> từ, <T>s; soi: <a> lặng, <b> từ đệm, <c> nói lại; xem <k> khung"`

### D3. Cảm xúc và cấu trúc
Viết cho chính mình (không cần nộp): người xem nên thấy gì sau 60 giây? Đoạn nào là **hook** thật sự (câu gây tò mò, con số, lời cảnh báo)? Đoạn nào là bằng chứng, ví dụ, lời kêu gọi? Đoạn nào lặp ý, lan man, lạc đề (`removed.kind = offtopic`)?
- Bằng chứng: `log direct "cấu trúc: hook ở @<từ>, ý chính <n> phần, lạc đề @<từ>-<từ>"`

### D4. Mượn kiến thức đúng vấn đề
Áp bài học đã tra vào đúng quyết định (nhịp theo phong cách, hook 3 giây, chữ nhấn). Nếu bài học mâu thuẫn `taste` của kênh thì theo `taste`.

### D5. Biên kịch và cắt, đọc lại lời
- Chọn `cutWords` (chỉ số từ bị bỏ): từ đệm đứng riêng, câu nói lại (bỏ **lần nói trước**, giữ lần nói tốt nhất), phần lạc đề, lời chào dài nếu phong cách đòi vào thẳng.
- Chọn `gapMs` (khoảng lặng dài nhất được giữ giữa hai từ): `calm` 800, `normal` 400, `fast` 250 làm điểm xuất phát.
- **Đọc lại lời sau khi cắt**: ghép các từ còn lại thành văn, đọc xem còn xuôi, còn đủ ý, còn giữ câu chào/câu chốt cần thiết không. Cắt giữa chừng một câu là lỗi nặng nhất.
- Có `targetSeconds`: so ước tính (lệnh `plan validate` in `estimatedOutputSec`) với mục tiêu, lệch quá 15% thì cắt thêm hoặc nới bớt. Hook và B-roll được tính thêm.
- Bằng chứng: `log direct "cắt <n> từ, <gap>ms; ước tính <A>s thành <B>s (mục tiêu <C>s); đã đọc lại lời: <ổn / sửa @...>"`

### D6. Tra kho tài nguyên
`assets search "<mood hoặc tên>" --kind bgm|sfx|font|image|effect`. Chỉ lấy mục `available: true` và `enabled` chưa tắt. Mục có `attribution` (CC-BY) thì ghi lại để caption đăng bài nêu nguồn nhạc. Không có mục hợp thì bỏ lớp đó (không có nhạc còn hơn nhạc sai), và nói rõ trong `summary`.
- Bằng chứng: `log audio "nhạc: <tên> (<mood>, <bpm> bpm); SFX: <n> điểm theo mật độ <low|medium|high>"`

### D7. Dựng plan
Điền từng khối theo tham chiếu: hook (`hooks.md`), phụ đề (`captions.md`), hiệu ứng chữ (`effects.md`), B-roll (`broll.md`), nhạc và SFX (`audio.md`), bìa (`covers.md`), meta đăng bài. Lược đồ ở `plan-schema.md`.
- Bằng chứng: `log effects "hook: <loại> '<chữ>'; <n> hiệu ứng chữ, <m> B-roll (lý do: ...)"` và `log cover "3 bìa ở <t1>s, <t2>s, <t3>s: <vì sao>"`

### D8. Chấm 3 lượt (tự kiểm trên plan)

Đi lần lượt ba lượt, mỗi lượt một câu hỏi, và ghi kết quả từng lượt. Mỗi lượt tìm lỗi thật; không có lỗi thì ghi "đạt" kèm bằng chứng cụ thể, không viết suông.

1. **Lượt nội dung và cấu trúc**: lời còn xuôi sau khi cắt? Hook có thật sự là điều hay nhất? Có đoạn nào bị cắt mất ý, mất ví dụ cần thiết? Câu chốt/CTA còn?
2. **Lượt nhịp và độ dài**: ước tính độ dài so với mục tiêu; không có khoảng 12 giây liền không có gì xảy ra (không chữ, không đổi cảnh, không zoom); không quá dày hiệu ứng so với mật độ phong cách và luật kênh ("ít hiệu ứng hơn" trong `taste`).
3. **Lượt chữ và tuân thủ**: mọi `keepWords` còn đúng từng ký tự trong `summary`, hiệu ứng chữ, `captions.highlight`, `meta`; không con số/giá nào ngoài lời nói và `brief`; từng luật cứng trong `taste` đã được tôn trọng (liệt kê luật nào, đạt vì sao); mục bị `enabled: false` hoặc `available: false` không được dùng.

- Bằng chứng: `log direct "chấm 3 lượt: nội dung <đạt/sửa ...>; nhịp <...>; chữ & luật <...>"`

### D9. Trích khung ra nhìn, sửa hoặc giữ có lý do
Chưa có video dựng, nên nhìn khung **gốc** tại những điểm plan phụ thuộc vào hình:
- khung dưới hook và dưới mỗi hiệu ứng chữ lớn: chữ có che mặt người nói, che vật đang nói tới không? (`captions.position` có cần đổi sang `middle`/`behind` không?)
- khung ứng viên bìa (`covers[].frameAt`): mặt rõ, mắt mở, không mờ chuyển động.
- khung tại mỗi B-roll `layout: full`: có che đúng cảnh cần xem không.

Với từng khung ghi **hai kết cục duy nhất**: "sửa: ... vì ..." hoặc "giữ: ... vì ...". Không ghi "ổn" trống không. Sau khi máy xuất bản dựng, 6 khung kiểm của máy sẽ cho bạn thấy chữ tràn hay vùng an toàn; nếu chủ kênh nhờ xem lại, dùng `frames` trên video gốc và `Read` các file trong `qa/`.
- Bằng chứng: `log direct "nhìn <k> khung: sửa <x> (...), giữ <y> (...)"`

### D10. Nộp
Trả khối ```json EditPlan; máy tự kiểm tra rồi nộp. Nếu hồ sơ không tự duyệt, plan chờ chủ kênh ở "Cần tôi".
- Bằng chứng: `log direct "đã nộp plan v<N>: <A>s thành <B>s, <n> thay đổi, chờ duyệt"`

## Khi trả lời chủ kênh

3 đến 6 dòng, tiếng Việt, văn bản thuần: (1) dựng thế nào và vì sao, (2) độ dài trước và sau, (3) một điều bạn không chắc hoặc cần họ xác nhận. Không liệt kê kỹ thuật, không khoe công cụ. Nếu thiếu thứ cần (không có nhạc hợp, thiếu thông tin giá), nói thẳng.

## Việc lẻ
- Chủ kênh hỏi "vì sao cắt chỗ này": nêu `removed`/lý do cụ thể, mốc thời gian, đoạn lời bị bỏ.
- Chủ kênh yêu cầu thứ trái luật cứng của kênh: nói rõ mâu thuẫn, hỏi giữ luật hay đổi luật, rồi mới làm.
- Không đủ dữ liệu (chưa có lời chép hay phân tích): nói máy chưa chạy bước nào, đừng đoán.
