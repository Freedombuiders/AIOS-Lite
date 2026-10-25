# Mẫu edit (Dựng nhanh): dựng bằng block có sẵn

Việc Dựng nhanh có một **mẫu edit** chủ kênh đã chọn (`project.quick.templateId`). Mẫu là bộ block HyperFrames làm sẵn (chữ theo nhịp, cảnh minh hoạ, khung cảnh trám, logo cuối) cùng luật dùng chúng. **Bạn không viết HTML hay hiệu ứng**: bạn chọn block, điền chữ và props, neo vào từ trong lời chép. Máy dựng block, áp chỉnh tay của chủ kênh lên trên, rồi xuất khi chủ kênh bấm Xuất.

Prompt có mục **MẪU EDIT** cho đúng mẫu đang dùng: luật của mẫu (`rules.md`), danh sách component với props và giới hạn, các hiệu ứng vào (`animIn`), kiểu phụ đề và mật độ tiếng động. Luật của mẫu là luật cứng, như `taste` của kênh.

## Component → trường trong plan

| `kind` của component | Ghi vào | Ghi chú |
|---|---|---|
| `beat` | `beats[]` | `component`, `kicker?`, `title`, `sub?` là trường riêng của beat (không nằm trong `props`) |
| `scene` | `scenes[]` | nội dung trong `props`, theo đúng schema của component |
| `graphic` | `graphics[]` | logo cuối, nhãn tên; `assetId` khi cần ảnh (logo) |
| `broll-frame` | `brolls[]` | khung cảnh trám của mẫu; bạn chỉ chọn `layout`, máy lắp khung |

Ghi `component` đúng id trong danh sách (ví dụ `text-beat`, `scene-steps`). Component không có trong mẫu thì máy từ chối plan.

## Props

- `text`: chữ thường. `markup`: `*từ*` để tô nổi bật, `|` để xuống dòng.
- `list`: mảng chữ, mỗi mục một dòng, giữ đúng thứ tự người nói.
- `number`: số. `color`: mã màu `#RRGGBB`.
- `asset`: một `assetId` trong TƯ LIỆU hoặc KHO GỢI Ý. Không bịa.
- Giới hạn `≤n từ`, `≤n dòng`, `≤n mục` và dấu `*` (bắt buộc) đi kèm từng prop. Vượt giới hạn chữ là cảnh báo, thiếu prop bắt buộc là lỗi.
- Chữ trên màn hình lấy nguyên cụm người nói dùng; không viết lại thành câu khác, không sửa từ cần giữ nguyên.

## Thời điểm

- Neo mọi phần tử bằng `anchorWord` (từ đầu tiên của cụm đang nói), không neo vào từ bị cắt hay `(tiếng)`.
- `duration` trong khoảng min–max của component; hết ý thì hết chữ.
- Không để hai phần tử cùng track chồng thời gian; không đặt chữ lớn khi đang có cảnh minh hoạ hoặc cảnh trám dạng thẻ (xem luật của mẫu).

## Hiệu ứng vào và âm thanh

- `animIn` là id trong danh sách hiệu ứng vào của mẫu (component có thể chỉ nhận một phần). Đổi hiệu ứng theo nội dung, đừng lặp một kiểu quá nhiều lần liền.
- `sound.mode`: `auto` dùng tiếng của mẫu cho hiệu ứng đó (mặc định), `none` im lặng, `asset` dùng một SFX trong kho (`assetId`). `volume` 0–2, 1 là mức của mẫu.

## Tư liệu, kho và cảnh trám

- **TƯ LIỆU** là ảnh/video chủ kênh gửi kèm mô tả. Dùng trước tiên: B-roll `source: "upload"`, đúng `assetId`, chép mô tả vào `hint`, neo vào câu đang nói đúng nội dung đó. Ảnh nhỏ của tư liệu được đính kèm để bạn nhìn.
- **KHO GỢI Ý** là danh sách máy chọn sẵn từ Kho của tôi, nhạc và SFX theo mẫu, mỗi mục có `assetId` thật. Chỉ chọn trong danh sách này.
- Chỗ cần cảnh trám mà không có tư liệu hợp: nếu chủ kênh cho tìm thêm, ghi B-roll `source: "pexels"`, **không** `assetId`, kèm `query: { description, keywords }` (mô tả tiếng Việt điều cần thấy, 2–4 từ khoá tiếng Anh cụ thể như `["laptop", "night", "working"]`). Máy tìm, chấm theo câu đang nói và tải về; không có cảnh đạt thì máy bỏ chỗ đó. Không cho tìm thêm thì bỏ chỗ trám.

## Cài đặt của chủ kênh

Mục DỰNG NHANH trong prompt ghi cài đặt chủ kênh chọn; máy ép lại nếu plan lệch:

- Tự cắt tắt: `autoCut: false`, `cutWords: []`, giữ nguyên video.
- Tự cắt bật: `autoCut: true`, mức nhẹ / vừa / sát gợi ý `gapMs` 800 / 400 / 250.
- Nhạc: không nhạc thì bỏ `music`; chủ kênh chọn bài thì giữ đúng bài đó; AI chọn thì lấy trong KHO GỢI Ý. `music.duck` theo cài đặt giảm nhạc khi nói.
- Ghi chú của chủ kênh đứng trên mọi luật khác.

## Chỉnh tay của chủ kênh

Chủ kênh chỉnh trong editor (vị trí, cỡ, chữ, hiệu ứng vào, ẩn một phần tử) và tự thêm phần tử. Những chỉnh này nằm ngoài plan, AI không ghi vào. Prompt liệt kê chúng ở mục PHẦN TỬ CHỦ KÊNH ĐÃ SỬA TAY: **giữ nguyên id**, không xoá, không viết lại, không thêm lại phần tử chủ kênh đã ẩn. Máy cũng tự chép lại phần tử chủ kênh tự thêm nếu plan mới làm mất.

## Mẫu cơ bản (`style:<id>`)

Mẫu có id `style:<id>` là 21 phong cách cũ bọc lại (mẫu cơ bản). Với chúng, dùng `overlays` (6 hiệu ứng dựng sẵn, xem `effects.md`), không dùng `beats`/`scenes`; vẫn ghi `planFormat: 2` và `templateId`.
