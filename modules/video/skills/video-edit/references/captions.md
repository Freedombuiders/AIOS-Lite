# Phụ đề tiếng Việt: chia chữ, tô từ khoá, từ cần giữ

Máy dựng phụ đề từ **lời chép đã cắt** (mỗi từ có mốc thời gian) bằng chữ HTML theo hồ sơ kênh và phong cách. Bạn quyết định bốn thứ: `styleId`, `position`, `maxWordsPerChunk`, `highlight`.

## Chia chữ (`maxWordsPerChunk`)

Một khối phụ đề hiện cùng lúc tối đa `maxWordsPerChunk` từ.

| Nhịp / loại video | `maxWordsPerChunk` |
|---|---|
| Nhanh, gắt (`fast`, TikTok, công nghệ, bán hàng) | 2 đến 3 |
| Bình thường (`normal`) | 3 đến 4 |
| Chậm, bài giảng (`calm`), đoạn dài | 5 đến 6 (câu đầy đủ) |
| Karaoke / từng từ (`/podcast`) | theo từng từ, chunk 4 đến 6 |

Tiếng Việt: mỗi **tiếng** là một từ trong lời chép (whisper tách theo âm tiết), nên "dựng video" là 2 từ. Quy tắc chia mà máy theo và bạn cần nhớ khi chọn con số:

- Khối không **vắt qua ranh giới đoạn cắt**: sau điểm cắt luôn bắt đầu khối mới, để chữ không nhảy giữa hai cảnh.
- Khối nên ngắt ở chỗ nghỉ tự nhiên (dấu phẩy, "và", "nhưng", "vì") khi có thể; không để dính một tiếng lẻ cuối câu (VD "dựng video" + "nhanh" rời nhau là xấu).
- Giữ cụm không tách: số + đơn vị ("50 %", "100 W", "3 bước"), họ tên, tên sản phẩm, từ cần giữ nguyên.
- Mỗi khối hiện ít nhất khoảng 0,4 giây; nhanh hơn thì người xem không đọc kịp, khi đó tăng `maxWordsPerChunk`.

## Vị trí (`position`)

- `bottom`: mặc định, dưới khung nhưng **trên vùng giao diện của nền tảng** (xem `covers.md` về vùng an toàn: khoảng 25% dưới cùng bị nút và caption đăng bài che trên TikTok/Reels).
- `middle`: video có mặt người ở nửa trên và chữ cần nổi, hoặc phong cách điện ảnh/hài.
- `behind`: chữ nằm **sau lưng người nói** (cần tách nền). Chỉ dùng khi phong cách đòi hỏi và người nói chiếm khung rõ ràng; nếu không chắc, dùng `bottom`.
- Nhìn khung hình (D9): chữ không được che mặt, miệng, vật đang nói tới.

## Từ nhấn (`highlight`)

`highlight` là danh sách từ hoặc cụm sẽ được tô màu nhấn (màu `accent` của hồ sơ, hoặc `highlight` của phong cách) và phóng nhẹ.

- Chọn **thuật ngữ, con số, tên công cụ, lợi ích, từ cảm xúc chính**. Không chọn từ chức năng ("là", "và", "thì").
- Tối đa khoảng **8 đến 12 từ cho cả video**. Nhấn nhiều thì không còn là nhấn (validate cảnh báo trên 12).
- Ghi **đúng như trong lời chép** (khớp không phân biệt hoa thường). Cụm nhiều tiếng ghi nguyên cụm: `"3 bước"`.
- Mỗi lần xuất hiện của từ đó trong video đều được tô; nếu chỉ muốn nhấn một lần thì dùng hiệu ứng `keyword-pop` thay vì `highlight`.
- Ưu tiên nhấn từ mà **người nói cũng nhấn giọng**; nghe qua lời chép tìm chỗ "lên giọng" hoặc lặp lại.

## Từ cần giữ nguyên (`profile.keepWords`)

Tên sản phẩm, thương hiệu, tên riêng, thuật ngữ người nói đã chọn. Quy tắc cứng:

1. Chữ đó trong phụ đề, `highlight`, `overlays[].props`, `hook.text`, `meta` phải **giống từng ký tự** với `keepWords` (dấu, hoa thường, dấu cách).
2. **Không "sửa chính tả"**. Nếu whisper chép "frido os" mà `keepWords` có "FreedomOS", chữ hiển thị là "FreedomOS" (máy đã dùng `keepWords` làm gợi ý khi chép; nếu vẫn sai, **báo cho chủ kênh** thay vì tự đoán, hoặc sửa bằng cách đưa đúng từ vào `props` của hiệu ứng).
3. Không dịch, không viết tắt, không đổi sang chữ thường, không tách hoặc nối.
4. Khi không chắc một từ lạ có phải tên riêng không: giữ nguyên như lời chép và hỏi chủ kênh một câu.

## Kiểu chữ (`styleId`)

Mã kiểu chữ trong kho (`caption:*`), mặc định theo phong cách (cột "phụ đề" ở `styles.md`): `highlight-bar`, `bottom-clean`, `outline-highlight`, `boxed`, `karaoke`, `pair-words`, `bold-uppercase`... Hồ sơ kênh có thể ép font phụ đề riêng (luôn dùng font hỗ trợ tiếng Việt đầy đủ dấu). Đừng tự chọn kiểu chữ trái luật kênh (VD kênh cấm chữ đỏ).
