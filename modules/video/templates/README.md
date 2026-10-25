# Mẫu edit (Dựng nhanh)

Mỗi thư mục con là một mẫu cài sẵn. Mẫu chủ kênh cài thêm đặt ở `<data>/video-edit/templates/<id>/` với cùng cấu trúc. Hợp đồng kiểu: `server/edit/templates/types.ts`; kế hoạch: `docs/dung-nhanh-gd1-plan.md` › Template.

```
<id>/
  template.json      TemplateManifest (id trùng tên thư mục, kiểm tra bằng zod khi nạp)
  rules.md           luật cho đạo diễn, tiếng Việt, gọn
  components/*.html  block HyperFrames, mỗi block một sub-composition
  poster.webp        (tuỳ chọn) ảnh thẻ mẫu
  preview.mp4        (tuỳ chọn) video xem trước
```

Block:

- Bọc toàn bộ style, markup và script trong `<template>`; root `#root` có `data-composition-id` bằng id component, không khai `data-width`/`data-height` để lấp đúng khung host ở mọi tỉ lệ (dùng đơn vị `cqw`/`cqh`/`cqmin`); một `gsap.timeline({ paused: true })` gán vào `window.__timelines["<id>"]` sau khi dựng xong.
- Props đến qua biến composition (`data-composition-variables` khai trên `<html>`, đọc bằng `window.__hyperframes.getVariables()` một lần khi dựng). Luôn có `duration` và `animIn`.
- Font và màu lấy từ biến CSS kế thừa (`--th-font-title`, `--th-font-sub`, `--th-accent`, ...); không tự tải font hay tệp nào qua mạng.
- Tất định: không `Math.random`, `Date.now`, `requestAnimationFrame`, `setInterval`, `setTimeout`, không lặp vô hạn (`repeat: -1`).

Kiểm tra: `npx vitest run modules/video/server/edit/templates` và `npx hyperframes check` trên một composition có nhúng block.

## Lỗi đã biết

**HyperFrames 0.8.156: video trong block lấy khung theo giờ toàn cục.** Một `<video>`/`<audio>` trong block chỉ có `data-var-src` (src gán từ biến lúc chạy) thì HTML biên dịch không có `src`; HyperFrames định giờ media lồng từ HTML biên dịch, nên media này chỉ được tìm thấy lúc chạy và bị đặt lên timeline gốc. Kết quả: clip chạy theo giờ của cả video chứ không theo slot (slot bắt đầu ở giây 4,2 thì hiện khung giây 4,2 của clip thay vì khung đầu, clip ngắn hơn thì đứng ở khung cuối). Ảnh `<img data-var-src>` không bị.

Cách né (đã làm trong `server/edit/pipeline/composition-v2/blocks.ts` › `blockInstance`): slot nào có video thì dùng một bản chép riêng của block với `src` viết sẵn bằng giá trị biến (tên file theo hash nội dung); có `src` thật thì media được dời theo slot như mọi media lồng. Khi viết block: giữ `data-var-src` trên thẻ media, đặt `data-start="0"` và `data-track-index`, không viết `src` cố định, không tạo thẻ `<video>` bằng script. Nâng HyperFrames thì render lại một B-roll video đặt giữa video (`hyperframes render` rồi xem khung đầu của slot) để biết đã hết lỗi chưa; hết thì bỏ bản chép riêng.
