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
