# 6 hiệu ứng chữ dựng sẵn

Giai đoạn 1 có đúng **6 hiệu ứng** dựng bằng HTML + GSAP, đặt trong `overlays[]`. Tên khác bị renderer bỏ qua (validate cảnh báo). Hiệu ứng "đẹp" trong kho (`effect:glitch-decode`, `effect:count-up`...) là hướng thể hiện: gần nhất thì dùng `big-number` thay `count-up`, `two-tier-title` thay `two-tier-hook`.

Mỗi phần tử `overlays[]`:

```json
{ "id": "o1", "effect": "big-number", "anchorWord": 30, "at": 9.5, "duration": 2.5, "props": { "value": "50%", "label": "thời gian dựng" } }
```

- `anchorWord`: chỉ số từ người nói bắt đầu nhắc điều đó (hiệu ứng hiện **đúng lúc nói**). Không neo vào từ bị cắt.
- `at`: giây trong video đã dựng (ước tính hiện tại, máy dời lại theo `anchorWord`).
- `duration`: 1,5 đến 4 giây cho chữ ngắn; danh sách 5 đến 8 giây. Không để hiệu ứng che chữ người nói quá lâu.
- `props`: chuỗi, số hoặc mảng chuỗi. **Mọi chữ trong `props` tuân theo `keepWords`** và không bịa số.

| `effect` | Dùng khi | `props` |
|---|---|---|
| `two-tier-title` | hook 3 giây đầu, mở chương, câu chốt: dòng nhỏ dẫn dắt phía trên, dòng lớn chốt ý | `small` (dòng nhỏ, tuỳ chọn), `big` (dòng lớn) |
| `keyword-pop` | một từ/cụm quan trọng bật lên rồi về chỗ cũ: thuật ngữ, lợi ích, câu gây cười | `text` |
| `big-number` | con số quyết định: doanh thu, phần trăm, giá, lượt xem; số chạy từ 0 tới giá trị | `value` (chuỗi như "50%" hoặc số), `label` (đơn vị/ý nghĩa), `prefix?`, `suffix?` |
| `stacked-list` | người nói liệt kê 3 đến 5 ý: các ý hiện lần lượt thành cột dọc | `title` (tuỳ chọn), `items` (mảng chuỗi, mỗi mục ngắn) |
| `compare-ab` | so sánh trước và sau, cũ và mới, A và B: chia đôi khung | `labelA`, `textA`, `labelB`, `textB` |
| `cta-button` | lời kêu gọi cuối: theo dõi, nhắn tin, bấm giỏ hàng | `text` |

> Tên props ở bảng này là hợp đồng giữa đạo diễn và renderer. Nếu renderer đổi tên, bảng này phải đổi theo; `plan show` của một plan cũ cho thấy tên đang dùng.

## Nguyên tắc

1. **Một hiệu ứng, một ý.** Hiệu ứng phải làm rõ điều người nói vừa nói, không trang trí.
2. **Mật độ theo phong cách và luật kênh.** Gợi ý mỗi 10 giây: `calm` 0 đến 1, `normal` 1 đến 2, `fast` 2 đến 3 hiệu ứng (kể cả hook). Kênh có luật "ít hiệu ứng hơn" thì giảm một bậc.
3. **Không chồng.** Hai hiệu ứng không cùng lúc, trừ hook + phụ đề. Chừa ít nhất 1,5 giây giữa hai hiệu ứng.
4. **Tránh vùng cấm** (xem `covers.md`): chữ lớn không nằm trong 25% dưới cùng hoặc 10% trên cùng của khung dọc.
5. **Khớp phụ đề.** Hiệu ứng chữ nhắc lại đúng từ phụ đề đang nhấn thì chọn **một** trong hai (hiệu ứng, hoặc `highlight`), không cả hai cho cùng một từ.
6. `zooms[]` (phóng nhẹ 1.08 đến 1.2, 1 đến 2 giây) dùng để nhấn nhịp cảm xúc hoặc che chỗ nối cắt (jump cut), đặt trên hoặc ngay sau điểm nhấn. Không zoom liên tiếp quá 3 lần trong 10 giây.
7. Chỉ dùng số/giá có trong lời nói hoặc `brief`. Cần "tạo ra" số liệu để hiệu ứng đẹp thì **không làm**.

## Ví dụ theo phong cách

- `/kienthuc`: `two-tier-title` ở hook, `keyword-pop` cho thuật ngữ mới, `stacked-list` khi liệt kê, `cta-button` cuối.
- `/congnghe`, `/taichinh`: `big-number` cho số liệu, `compare-ab` cho trước và sau.
- `/sanpham`: `big-number` cho giá và phần trăm giảm (lấy từ `brief`), `cta-button` ("Nhắn tin để đặt hàng").
- `/giaoduc`, `/tamsu`: ít hoặc không hiệu ứng; chỉ tiêu đề chương hoặc một câu chốt.
