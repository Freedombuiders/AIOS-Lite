# T27 · Dọn để mở nguồn, bản gọn, cài đặt

> Nhánh Cuối · 3 ngày · Phụ thuộc: mọi task · Kế hoạch mục 5.9

## Mục tiêu

Một người lạ tải về, chạy một lệnh, và có năm màn chính dùng được. Không có gì trong kho mã mà dự án không có quyền phát hành.

## Việc phải có người quyết, không phải agent

- [ ] **Nguồn gốc code.** Các module trong `modules/` được port từ `freedom_os`, repo mang giấy phép thương mại. Cần chủ dự án xác nhận bằng văn bản, cho từng module, rằng code đó thuộc quyền của mình để phát hành mở. Agent làm task này chỉ lập danh sách và chạy `scripts/check-provenance.mjs`; không tự kết luận.
- [ ] Chọn giấy phép cho lõi (hiện là MIT) và xác nhận cách phát hành module Zalo (AGPL-3.0).
- [ ] Phát hành từ kho hiện tại hay từ một kho mới không kèm lịch sử.

## Các bước cho agent

**Rà soát**

- [ ] Chạy `scripts/check-provenance.mjs`, đưa kết quả vào báo cáo.
- [ ] Lập bảng: từng thư mục dưới `modules/` và `src/`, nguồn gốc ghi trong `docs/dev/port/`, giấy phép, và có file nào mang ghi chú bản quyền của bên khác không.
- [ ] Tìm trong toàn kho: tên `ClaudeClaw`, `claudeclaw`, `FreedomOS`, đường dẫn máy cá nhân (`/Users/`, `C:\Users\`), địa chỉ email, tên miền riêng, khoá hay mã trông như bí mật. Liệt kê; sửa những chỗ chắc chắn là sót (đường dẫn trong tài liệu, email trong README); chỗ nào là tên kỹ thuật đang được code dùng (`CLAUDECLAW_CONFIG`, lược đồ `claudeclaw-team/v1`) thì đề xuất cách đổi kèm bước chuyển tiếp, không đổi mù.
- [ ] `modules/video/server/studio/bridge.ts:14` nạp một repo riêng nằm cạnh. Cho nó tắt êm khi không có, và ghi rõ trong tài liệu.

**Bản gọn**

- [ ] Một danh sách module cài sẵn lúc thiết lập: `care`, `crm`, `marketing`, `social`, `ads`, `learn`, `dream`. Các module khác vẫn có trong trang Module để tự thêm.
- [ ] Module `zalo` không cài sẵn. Màn thiết lập có một bước riêng: giải thích AGPL và rủi ro khoá nick của thư viện không chính thức, người dùng bấm đồng ý mới cài.
- [ ] `module.json` của `zalo` có `"license": "AGPL-3.0"` (T05). Cập nhật `THIRD_PARTY_NOTICES.md`.

**Thiết lập lần đầu**

- [ ] Một trình hướng dẫn năm bước trong web: (1) tạo brain cho công ty đầu tiên bằng năm câu hỏi, (2) nối GenBot và kiểm bằng `doctor`, (3) cài gói đội ba bot, (4) tuỳ chọn: cài Zalo và quét QR, (5) tuỳ chọn: nối Composio.
- [ ] Bước nào cũng bỏ qua được và làm lại được từ Cài đặt.
- [ ] Lệnh cài một dòng cho macOS và Windows: kiểm Node, cài phụ thuộc, tạo `.env` với khoá mã hoá, chạy. Không cài gì ngoài thư mục dự án mà không hỏi.
- [ ] Lệnh `aios doctor`: kiểm Node, cổng, GenBot, `yt-dlp`, `ffmpeg`, `cloudflared`, git trong thư mục brain. Mỗi mục thiếu có một dòng cách sửa.

**Tài liệu**

- [ ] `README.md` mới: sản phẩm là gì, ảnh năm màn chính, cài, và mục "Cái gì chạy ở đâu" nói rõ dữ liệu nào nằm trên máy, cái gì đi ra ngoài (nhà cung cấp model qua GenBot, Composio, Apify, cloud của dự án).
- [ ] `docs/HUONG-DAN-SU-DUNG.md` cập nhật theo menu mới.
- [ ] Cập nhật `docs/MODULES.md`: hiện nó ghi `kol`, `video`, `radar`, `finance` là hoãn, trong khi chúng đã có trong kho.

## Test

- Trên một bản sao sạch của kho, trong một thư mục tạm: chạy lệnh cài, rồi `aios doctor`, rồi mở năm màn chính ở `?mock=1`.
- `npm run typecheck`, `npm run build`, và toàn bộ `npx vitest run` qua.
- Test kiến trúc: không file nào ngoài `modules/zalo` import từ `modules/zalo` trừ qua giao diện `care-kit`.

## Xong khi

- Bảng rà soát nguồn gốc đã có và đã được chủ dự án ký từng dòng.
- Một người chưa từng thấy dự án làm theo README và tới được màn Hôm nay mà không hỏi ai.

## Ghi chú

Đừng phát hành khi mục "Nguồn gốc code" chưa được xác nhận. Đây là rủi ro lớn nhất của cả dự án, và không sửa được sau khi đã công khai.
