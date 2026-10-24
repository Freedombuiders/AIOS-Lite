# Ảnh bìa và vùng an toàn

Máy làm **3 ảnh bìa** từ 3 khung hình bạn chọn (`covers[].frameAt`, giây trong video gốc) cộng chữ bạn viết (`title`, `subtitle`). Bạn chọn **khung nào** và **chữ gì**; máy đặt chữ trong vùng an toàn theo font bìa và kiểu bìa của hồ sơ kênh (`profile.coverStyle`, `brand.fontCover`).

```json
"covers": [
  { "frameAt": 3.2, "title": "Giảm 50% thời gian dựng", "subtitle": "3 bước đơn giản" },
  { "frameAt": 21.4, "title": "Dựng video nhanh gấp đôi" },
  { "frameAt": 44, "title": "Bạn đã thử chưa?" }
]
```

## Chọn khung (`frameAt`)

Xem các khung hình đính kèm và chọn 6 đến 10 ứng viên từ lời chép. Một khung bìa tốt:

- Mặt người rõ, mắt mở, biểu cảm có chủ đích (ngạc nhiên, cười, nghiêm túc), không mờ chuyển động, không đang nói dở miệng méo.
- Bố cục có **chỗ trống** cho chữ (thường nửa trên hoặc nửa dưới); người không bị cắt đầu.
- Hoặc là khung có vật chính (sản phẩm, màn hình) rõ ràng.
- 3 phương án **khác nhau** thật sự: khác khung, khác bố cục, ít nhất một khung không có mặt (sản phẩm/cận cảnh) nếu có.
- Không chọn khung trùng thời điểm có hiệu ứng chữ lớn (chữ chồng chữ).

Ghi lý do: `log cover "3 bìa ở 3.2s (mặt cười, nền sáng), 21.4s (cầm sản phẩm), 44s (cận cảnh màn hình); loại 12.0s vì mờ"`.

## Chữ bìa (`title`, `subtitle`)

- `title`: tối đa **5 đến 7 từ**, đọc được trong 1 giây ở kích thước nhỏ trên lưới trang cá nhân. Một ý, một con số hoặc một câu hỏi.
- `subtitle`: tuỳ chọn, tối đa khoảng 30 ký tự, bổ nghĩa cho `title`.
- **Chữ bìa không lặp lại nguyên văn hook** nhưng cùng một lời hứa. Không hứa điều video không giao. Không bịa số. Giữ `keepWords` đúng chữ.
- Theo luật kênh: kiểu bìa, màu, "không chữ đỏ"...

## Vùng an toàn (ước lượng, khung dọc 1080×1920)

Giao diện nền tảng đè lên video (tên kênh, caption đăng bài, nút tim/bình luận/chia sẻ, thanh tiến trình). Chữ quan trọng phải nằm trong vùng không bị che:

| Nền tảng | Trên cùng | Dưới cùng | Cạnh phải | Ghi chú |
|---|---|---|---|---|
| **TikTok** | ~150 px | ~480 px (caption, tên nhạc) | ~120 px (nút) | vùng nguy hiểm nhất là góc dưới phải |
| **Reels** (Instagram/Facebook) | ~250 px (nút tắt/tiêu đề) | ~340 px (caption) | ~120 px | lưới trang cá nhân Instagram cắt bìa **4:5 hoặc 1:1** ở giữa |
| **Shorts** (YouTube) | ~220 px | ~420 px (kênh, nút đăng ký) | ~140 px | tiêu đề video đè lên phần dưới |

Quy tắc chung cho cả hai nơi dùng chung một video: chữ trong khung **x 60 → 940, y 250 → 1440**. Với bìa (ảnh tĩnh) còn thêm: lưới trang cá nhân TikTok/Instagram hiện bìa **cắt giữa theo tỉ lệ 3:4 hoặc 4:5**, nên chữ phải đủ nằm trong khung giữa cao khoảng 1350 px (cách trên và dưới ~280 px) và chừa lề trái/phải ~70 px.

Với video 16:9 (YouTube): chữ trong 90% giữa khung, tránh góc dưới phải (đồng hồ, nút) và 12% đáy (thanh tiến trình). Với 1:1 và 4:5 (feed): lề an toàn 8% mỗi cạnh.

Áp dụng vào plan:
- `captions.position: "bottom"` đã chừa chỗ theo bảng trên, bạn không phải tính; nhưng hiệu ứng chữ lớn (`big-number`, `two-tier-title`) hãy đặt thiết kế để nằm trong vùng giữa.
- Nếu kênh đăng cả TikTok và Reels/Shorts, dùng khung chung (x 60 → 940, y 250 → 1440).
- Chủ kênh đặt `platform` trong hồ sơ: `tiktok`, `facebook`, `youtube`, `instagram`; theo đó chọn dòng bảng gần nhất.
