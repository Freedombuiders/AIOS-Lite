# T05 · Zalo chỉ còn chat

> Nhánh Chăm khách · 2 ngày · Phụ thuộc: không · Kế hoạch mục 5.2.3 việc 4, 5, 7

## Mục tiêu

Module Zalo chỉ còn: quét QR, nhận tin, đồng bộ lịch sử, gửi tin. Mọi tính năng marketing tắt theo mặc định và không còn trên menu.

## Làm và không làm

- Làm: tắt mặc định, ẩn menu, gỡ phụ thuộc của lõi chat vào file marketing, ghi giấy phép.
- Không làm: xoá file marketing (giữ để dễ gộp sửa lỗi từ bản gốc); đổi thư viện `zca-js`.

## File đụng tới

| File | Việc |
|---|---|
| `modules/zalo/module.json:36-40` | `marketingEnabled` mặc định `false`; thêm `"license": "AGPL-3.0"` |
| `modules/zalo/web/index.tsx:30-40` | Mục menu marketing chỉ đăng ký khi cài đặt bật |
| `modules/zalo/server/ingest.ts:28` | Bỏ import trực tiếp `birthday.ts` |
| `modules/zalo/server/daemon.ts:121-134` | Kiểm lại: worker marketing đã nằm sau cài đặt |
| `modules/zalo/server/dashboard-routes.ts` | Các đường của marketing trả 404 khi cài đặt tắt |
| `modules/zalo/README.md` | Ghi rõ phạm vi mới |

## Các bước

- [ ] Đổi mặc định `marketingEnabled`. Máy đã cài từ trước giữ giá trị người dùng đã đặt; chỉ máy cài mới nhận mặc định mới.
- [ ] Trong `ingest.ts`: thay lời gọi vào `birthday.ts` bằng một hàm tuỳ chọn được truyền vào lúc dựng (`onContactSeen?`). `daemon.ts` chỉ truyền hàm đó khi `marketingEnabled` bật.
- [ ] Rà mọi `import` trong các file lõi chat (`session.ts`, `ingest.ts`, `history.ts`, `sender.ts`, `care-bridge.ts`, `connectors/zalo/*`, `limits.ts`, `store.ts`) tới các file marketing (`template.ts`, `variants.ts`, `group-broadcast.ts`, `list-broadcast.ts`, `birthday*.ts`, `broadcast-cost.ts`, `schedule.ts`, `send-window.ts`, `marketing-deps.ts`). Không còn cái nào.
- [ ] Thêm một test kiến trúc: đọc cây import của các file lõi chat, thất bại nếu chạm file marketing.
- [ ] Giao diện: bỏ `CampaignTabs`, `TemplatePicker` khỏi các trang chat khi cài đặt tắt.
- [ ] Thêm API `GET /api/m/zalo/accounts/:id/usage` trả số tin đã gửi hôm nay và trần, đọc từ `limits.ts` (trần mặc định 1.000 tin mỗi ngày, 20 tin mỗi 30 giây, lịch làm nóng nick `[30, 80, 150]` theo tuần).

## Test

- Test kiến trúc ở trên.
- `module.test.ts`: cài mới thì `marketingEnabled` là `false` và không worker marketing nào chạy.
- Đường `/api/m/zalo/list-broadcasts` trả 404 khi tắt.
- `usage` trả đúng số sau khi gửi 3 tin giả.

## Xong khi

- `npx vitest run modules/zalo` qua.
- Cài mới: menu Zalo chỉ còn trang tài khoản.
- Bật lại `marketingEnabled`: mọi thứ chạy như trước task này.

## Ghi chú

- Cả thư mục `modules/zalo` là AGPL vì 12 file gốc từ ZaloCRM (`modules/zalo/NOTICE`), trong đó có `session.ts`, `ingest.ts`, `sender.ts`, `limits.ts`. Lõi chat không tách khỏi AGPL được.
- Mockup đang ghi "46/200 tin". Con số đúng phải lấy từ API `usage`.
