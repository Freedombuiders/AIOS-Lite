Mẫu cho một người nói thẳng vào máy quay (video dọc). Chữ lớn màu vàng nói lại ý chính đúng lúc người nói nói ra; cảnh minh hoạ nền đen chỉ dùng khi lời nói là danh sách hoặc so sánh.

**Nhịp chữ (`beats`, component `text-beat`)**
- Mật độ: 1 nhịp mỗi 3–6 giây lời nói, video 30 giây khoảng 5–8 nhịp. Không để hai nhịp chồng thời gian.
- `title`: 2–6 từ, tối đa 2 dòng, lấy nguyên cụm người nói dùng (không viết lại thành câu khác). `|` để xuống dòng, bọc `*từ*` cho 1 cụm quan trọng nhất (tối đa 1 cụm mỗi nhịp, 1–3 từ).
- `kicker` (tuỳ chọn, ≤3 từ, in hoa): nhãn như "BƯỚC 1", "MẸO", "SAI LẦM". `sub` (tuỳ chọn, ≤8 từ): chỉ khi cần giải thích thêm.
- Neo `anchorWord` vào từ đầu tiên của cụm trong lời chép; `duration` 1,5–3 giây, kết thúc trước khi người nói sang ý khác.
- Hiệu ứng vào: `slide-up` mặc định; `typewriter` cho câu hỏi, lệnh, tên công cụ; `pop` cho con số, câu chốt; `slide-short` khi hai nhịp đi liền nhau; `fade` cho câu cảm xúc. Không dùng cùng một hiệu ứng quá 3 nhịp liên tiếp.

**Cảnh minh hoạ (`scenes`)**
- `scene-steps` khi người nói liệt kê 2–5 bước: `step` là số bước (0 để ẩn), `title` ≤6 từ, `items` mỗi mục ≤6 từ đúng thứ tự người nói. `at` lúc bắt đầu liệt kê, `duration` phủ hết đoạn liệt kê (tối đa 8 giây).
- `scene-before-after` khi so sánh hai trạng thái: `before`/`after` ≤8 từ, có thể kèm `beforeImage`/`afterImage` là `assetId` trong danh sách tư liệu.
- Tối đa 1 cảnh minh hoạ mỗi 10 giây; không đặt cảnh minh hoạ trong 3 giây đầu (giữ mặt người nói cho hook).

**Cảnh trám (`brolls`, khung `broll-frame`)**
- `layout`: `full` thay người nói (tối đa 3 giây), `card` thẻ viền vàng phía trên, `pip-circle` vòng tròn trên đầu cho vật thể hoặc ảnh nhỏ. `caption` ≤6 từ, chỉ khi cần ghi nguồn hoặc tên.
- Không đặt `card`/`pip-circle` cùng lúc với nhịp chữ (cùng vùng phía trên khung).

**Đồ hoạ (`graphics`)**: `logo-end` ở 1,5–3 giây cuối, `name` là tên kênh, `cta` ≤6 từ lấy từ lời kêu gọi của người nói nếu có.

**Zoom và âm thanh**
- Zoom nhẹ (scale 1,08–1,15) vào câu chốt hoặc con số, tối đa 1 lần mỗi 8 giây, không zoom khi đang có cảnh minh hoạ.
- `sound.mode` để `auto`: mỗi hiệu ứng vào có tiếng riêng của mẫu (gõ phím, vút, bụp), mật độ thấp; nhạc nền nhỏ, giảm khi có giọng.

**Phụ đề**: chữ trắng viền tối ở vùng ngực, tối đa 3 từ một lần; ghi 3–8 từ khoá (con số, thuật ngữ, lợi ích) vào `captions.highlight` để tô vàng.
