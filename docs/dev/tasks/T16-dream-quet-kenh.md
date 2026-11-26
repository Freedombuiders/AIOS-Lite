# T16 · Dream 100 phần 1: kênh, quét, video nổi bật

> Nhánh Marketing · 3 ngày · Phụ thuộc: T02 · Kế hoạch mục 5.7.1 đến 5.7.4

## Mục tiêu

Theo dõi tới 100 kênh. Mỗi sáng biết kênh nào vừa có video vượt trội so với chính nó.

## Bản vẽ tham chiếu

`Dream.dc.html`, `DreamFeed.dc.html` (phần danh sách; phần mổ xẻ là T17).

## File đụng tới

| File | Loại |
|---|---|
| `modules/_lib/collect/` | MỚI: chuyển từ `modules/radar/server/collectors/{apify,rsshub,parse,sources}.ts` và `channels.ts` |
| `modules/radar/server/…` | SỬA: gọi thư viện chung |
| `modules/dream/` (`module.json`, `migrations/001_init.sql`, `server/index.ts`, `channels.ts`, `scan.ts`, `outliers.ts`, `worker.ts`, `web/`) | MỚI |

## Các bước

- [ ] Chuyển phần thu thập dùng chung ra `_lib/collect/`. Radar import lại. `npx vitest run modules/radar` phải qua mà không sửa test nào. Phần xoay khoá Apify và tạm nghỉ 6 giờ đi theo.
- [ ] Định nghĩa `ChannelSource` (mục 5.7.3) và ba bản cài đặt: `apify`, `rss`, và một bản rỗng để sau này thêm nguồn khác.
- [ ] Module `dream`: `category: marketing`. Bảng `dream_channels`, `dream_videos`, `dream_runs` (SQL ở mục 5.7.1).
- [ ] Thêm kênh: nhận một link hoặc nhiều dòng. Phân tích bằng `parseChannel` sẵn có của Radar. Link trùng thì bỏ qua và báo. Đã có 100 kênh `active` thì từ chối.
- [ ] Mỗi kênh có một ghi chú `dream-100/kenh/<slug>.md` (`loai: kenh-dream`). Lý do theo dõi (`hoc_gi`) do chủ viết.
- [ ] `scan.ts`: với từng kênh `active`, gọi `listRecent(channel, n)`. `n` là 10 ở lần đầu, 3 nếu kênh đã quét hôm qua. Thêm video mới, cập nhật số đo video cũ. Mỗi kênh trong một khối `try`; lỗi thì ghi `last_error`, sau 3 ngày lỗi liên tiếp đổi `status='error'`.
- [ ] `outliers.ts`, hàm thuần: `median_views` là trung vị lượt xem của tối đa 30 video gần nhất, bỏ video dưới 48 giờ tuổi. Kênh dưới 5 video thì chưa tính. `ratio = views / median_views`. Chọn video có `ratio` từ ngưỡng (cài đặt, mặc định 3), tối đa 10 mỗi ngày, xếp theo `ratio`.
- [ ] `worker.ts`: chạy lúc 06:00 theo múi giờ cấu hình, có chạy bù trong 6 giờ, theo cách của `radar/server/worker.ts:24-33`. Ghi `dream_runs` kèm `cost_usd`.
- [ ] Trần chi mỗi ngày (cài đặt). Chạm trần thì dừng lượt quét và nêu mục cần chú ý.
- [ ] Nút chạy tay, và nút thử một kênh (quét riêng kênh đó, hiện kết quả hoặc lỗi).
- [ ] Trang Kênh theo dõi; trang Video nổi bật (bản này hiện số đo và tỷ lệ, cột mổ xẻ để trống).

## Test

- Thêm kênh thứ 101 bị từ chối.
- `outliers.test.ts`: kênh 4 video không có trung vị; video 12 giờ tuổi không vào trung vị; đúng 10 video đứng đầu được chọn.
- Một kênh ném lỗi: các kênh khác vẫn quét xong, lượt chạy kết thúc `ok` với ghi chú lỗi.
- Chạm trần chi: dừng đúng chỗ.
- Mở máy lúc 09:00: lượt 06:00 chạy bù. Mở lúc 13:00: không chạy bù.

## Xong khi

- `npx vitest run modules/dream modules/radar modules/_lib` qua.
- Với một khoá Apify thật và 3 kênh: có video trong bảng và ít nhất một ghi chú kênh.

## Ghi chú

- YouTube qua RSS chỉ có lượt xem. TikTok qua Apify có xem, thích, bình luận, chia sẻ, lưu.
- Chủ dự án nhắc một nguồn tên "treg" mà chưa rõ là gì. Khi biết, nó là một `ChannelSource` nữa.
