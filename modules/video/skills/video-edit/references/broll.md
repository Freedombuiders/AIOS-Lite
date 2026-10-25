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

Thứ tự ưu tiên: **sản phẩm thật (`product`/`upload`) > kho (`library`) > AI**. Hình thật của chính sản phẩm luôn thắng hình minh hoạ. Nguồn `ai` chỉ khi chủ kênh cho phép hoặc phong cách yêu cầu (điện ảnh, hài).

Không có `assetId` (hoặc không tìm thấy): máy chỉ hiện thẻ giữ chỗ có chữ; đừng làm vậy trừ khi đã nói với chủ kênh rằng bạn đề xuất cảnh này và họ cần bổ sung hình.

## Dựng nhanh: tư liệu (`hint`) và cảnh cần tìm (`query`)

- Tư liệu chủ kênh gửi kèm mô tả: `source: "upload"`, đúng `assetId`, chép nguyên mô tả vào `hint`. Tư liệu luôn đứng trước kho và cảnh tìm thêm.
- Chỗ cần cảnh mà không có tư liệu hợp (và chủ kênh cho tìm thêm): `source: "pexels"`, không `assetId`, thêm `query: { "description": "<điều cần thấy, tiếng Việt>", "keywords": ["<2–4 từ khoá tiếng Anh>"] }`. Máy tìm trong kho rồi Pexels, chấm theo câu đang nói, tải về và ghi công tác giả; không có cảnh đạt thì máy bỏ chỗ đó.
- Mẫu edit có thể có thêm layout riêng cho khung cảnh trám: xem mục MẪU EDIT của prompt.

## `layout`

- `full`: B-roll phủ toàn khung (video minh hoạ, ảnh sản phẩm rõ). Che người nói; dùng khi hình **là** nội dung.
- `card`: thẻ nổi (ảnh bo góc) trên nền người nói; người nói vẫn thấy được. Dùng cho ảnh sản phẩm, chụp màn hình, logo.
- `cutout`: PNG alpha thật nằm trên đầu người nói, không thẻ/viền/nền. Dùng cho `/edit-video-talking-head`; đặt `box` theo phần trăm khung và soát để không che mặt/tay.

Dọc 9:16: thẻ đặt nửa trên (trên vùng phụ đề, dưới vùng giao diện trên cùng). Phong cách sản phẩm (`/sanpham`, `/review`): ưu tiên `card`; `/huongdan` quay màn hình: thường không cần B-roll.

## `reason`

Một câu tiếng Việt, cụ thể, trích đúng lời người nói: `khi nói 'ưu đãi 30%'`, `che chỗ nhảy cắt giữa hai ý`, `minh hoạ cho thao tác bấm nút Xuất`. Không viết "cho sinh động".

## Giấy phép

Mục kho có `license` và `attribution`. CC-BY thì thêm dòng ghi nguồn vào `meta.caption`. Không dùng ảnh/clip nào không rõ nguồn. Không tải hình từ internet.
