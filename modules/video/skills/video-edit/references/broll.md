# B-roll: chèn đúng lúc, có lý do

B-roll là cảnh chèn lên trên giọng nói để minh hoạ điều người nói **đang nói**. Mỗi B-roll trong plan có lý do ghi rõ, hiện cho chủ kênh trong tab B-roll ("khi nói 'sạc 100W'") và chủ kênh bật/tắt từng cái.

```json
{
  "id": "b1",
  "anchorWord": 55,
  "duration": 2.5,
  "title": "Cận cảnh củ sạc 100W",
  "reason": "khi nói 'sạc 100W'",
  "source": "product",
  "assetId": "image:sac-100w",
  "layout": "card",
  "enabled": true
}
```

## Khi nào chèn

Chèn khi **có thứ cụ thể để cho xem**: tên sản phẩm, một con số có hình, một phần mềm, một địa điểm, một thao tác đang được nhắc tới. Che khoảng nhảy cắt (jump cut) hoặc làm mới hình sau 8 đến 10 giây chỉ có một khung người nói cũng là lý do chính đáng.

Không chèn khi: người nói đang kể cảm xúc, nhìn thẳng ống kính để thuyết phục (mặt người nói là nội dung), hoặc không có hình hợp (không có thì **bỏ**, đừng đặt thẻ giữ chỗ cho đủ số lượng).

Số lượng gợi ý: `calm` 0 đến 2, `normal` 1 đến 3, `fast` 2 đến 5 cho video một phút. Không hai B-roll liền nhau trong 3 giây.

## Neo và thời lượng

- `anchorWord`: từ người nói bắt đầu nhắc điều được minh hoạ; máy tự dời nếu cắt đổi. Không neo vào từ bị cắt.
- `duration`: **1,5 đến 4 giây** là vừa. Dài hơn 5 giây thì người xem quên mất người nói; dưới 1 giây thì không kịp nhìn. Hết cảnh thì quay lại người nói.
- Không để B-roll che câu chốt hoặc lời kêu gọi cuối.

## `source`

| source | Là gì | Cần |
|---|---|---|
| `product` | ảnh/video sản phẩm chủ kênh điền trong form thông tin của việc | `assetId` của mục tải lên (xem `project show`, trường `brief`) |
| `library` | ảnh/video trong kho (`assets search <từ> --kind image` hoặc `video`) | `assetId`, mục phải `available: true` và chưa bị tắt |
| `upload` | tệp chủ kênh đã tải lên cho việc này | `assetId` |
| `ai` | cảnh tạo bằng AI (RocketFlow) khi không có hình thật | `prompt` mô tả rõ cảnh. Chủ kênh duyệt kế hoạch trước, **bạn không tạo ảnh/video** |
| `pexels` | cảnh máy tìm trên Pexels (Dựng nhanh, khi chủ kênh cho tìm thêm) | `query`, để trống `assetId`; máy tải về kho rồi điền `assetId` (xem mục Dựng nhanh bên dưới) |

Thứ tự ưu tiên: **sản phẩm thật (`product`/`upload`) > kho (`library`) > Pexels > AI**. Hình thật của chính sản phẩm luôn thắng hình minh hoạ. Nguồn `ai` chỉ khi chủ kênh cho phép hoặc phong cách yêu cầu (điện ảnh, hài).

Không có `assetId` (hoặc không tìm thấy) và không có `query`: máy chỉ hiện thẻ giữ chỗ có chữ (với mẫu edit, bản xuất bỏ chỗ đó); đừng làm vậy trừ khi đã nói với chủ kênh rằng bạn đề xuất cảnh này và họ cần bổ sung hình.

## Dựng nhanh: tư liệu (`hint`) và cảnh cần tìm (`query`)

- Tư liệu chủ kênh gửi kèm mô tả: `source: "upload"`, đúng `assetId`, chép nguyên mô tả vào `hint`. Tư liệu luôn đứng trước kho và cảnh tìm thêm.
- Chỗ cần cảnh mà không có tư liệu hợp (và chủ kênh cho tìm thêm): `source: "pexels"`, không `assetId`, thêm `query: { "description": "<điều cần thấy, tiếng Việt>", "keywords": ["<2–4 từ khoá tiếng Anh>"] }`. `description` là câu đầy đủ để chấm, `keywords` là từ ngắn để tìm.
- Máy tìm lần lượt: tư liệu của dự án → Kho của tôi → video Pexels → ảnh Pexels (Pexels chỉ khi chủ kênh cho tìm thêm và đã có API key). Mỗi nguồn, agent nhìn ảnh nhỏ và chấm 1–5 theo câu đang nói; nguồn đầu tiên có cảnh từ 3 điểm thắng (điểm cao nhất, cảnh chưa dùng trước, không trùng cảnh của chỗ trám liền trước hoặc liền sau). Cảnh Pexels được tải về kho kèm giấy phép, tác giả và link gốc, rồi máy điền `assetId` và `source`.
- Không có cảnh đạt: máy bỏ chỗ trám của AI và ghi lý do vào nhật ký bước Đạo diễn; chỗ trám chủ kênh tự thêm thì giữ lại để chủ kênh chọn cảnh trong editor.
- Mẫu edit có thể có thêm layout riêng cho khung cảnh trám (ví dụ `pip-circle`): xem mục MẪU EDIT của prompt.

## `layout`

- `full`: B-roll phủ toàn khung (video minh hoạ, ảnh sản phẩm rõ). Che người nói; dùng khi hình **là** nội dung.
- `card`: thẻ nổi (ảnh bo góc) trên nền người nói; người nói vẫn thấy được. Dùng cho ảnh sản phẩm, chụp màn hình, logo.
- `cutout`: PNG alpha thật nằm trên đầu người nói, không thẻ/viền/nền. Dùng cho `/edit-video-talking-head`; đặt `box` theo phần trăm khung và soát để không che mặt/tay. Với mẫu edit, `cutout` được dựng thành `pip-circle`.
- `pip-circle` (mẫu edit có khung tròn, như `th-vang`): ảnh hoặc clip trong vòng tròn viền màu của mẫu, phía trên đầu người nói; người nói vẫn thấy rõ. Dùng cho vật thể, ảnh nhỏ, logo. Plan không dùng mẫu thì `pip-circle` hiện như `card`.

Dọc 9:16: thẻ đặt nửa trên (trên vùng phụ đề, dưới vùng giao diện trên cùng). Phong cách sản phẩm (`/sanpham`, `/review`): ưu tiên `card`; `/huongdan` quay màn hình: thường không cần B-roll.

## `reason`

Một câu tiếng Việt, cụ thể, trích đúng lời người nói: `khi nói 'ưu đãi 30%'`, `che chỗ nhảy cắt giữa hai ý`, `minh hoạ cho thao tác bấm nút Xuất`. Không viết "cho sinh động".

## Giấy phép

Mục kho có `license` và `attribution`. CC-BY thì thêm dòng ghi nguồn vào `meta.caption`; cảnh Pexels (Pexels License) không bắt buộc ghi nguồn, máy vẫn lưu tên tác giả. Không dùng ảnh/clip nào không rõ nguồn. Bạn không tự tải hình từ internet: cảnh Pexels chỉ đến qua `query`.
