# T10 · Khung giao diện mới

> Nhánh Giao diện · 3 ngày · Phụ thuộc: không · Kế hoạch mục 5.4

## Mục tiêu

Thanh bên sắp theo nhóm mới, thanh ra lệnh luôn ở đáy, màn Hôm nay theo thiết kế. Mọi trang cũ vẫn chạy.

## Bản vẽ tham chiếu

Thư mục `docs/dev/design-mockups/`. Mỗi file `.dc.html` là một màn; màu, cỡ chữ, khoảng cách nằm ngay trong thuộc tính `style`. Đọc `Sidebar.dc.html`, `ChatBar.dc.html`, `Main.dc.html`. Đây là bản vẽ, không phải code để chép: viết lại bằng Preact và Tailwind theo cách repo đang làm.

## File đụng tới

| File | Việc |
|---|---|
| `web/src/lib/nav.ts` | Sắp lại `CORE_NAV`, `GROUP_LABEL`, `GROUP_ORDER`, các nhóm thu gọn |
| `web/src/module-host/contracts.ts:6` | Thêm giá trị cho `NavGroup` |
| `src/modules/loader.ts:18-35`, `src/modules/sdk.ts:25-50` | Thêm giá trị `category` tương ứng |
| Khung app (thành phần chứa thanh bên) | Thêm thanh ra lệnh |
| `web/src/pages/HomeDashboard.tsx` | Màn Hôm nay |
| `web/src/styles/main.css` | Chỉ thêm biến màu còn thiếu; không đổi biến đang có |

## Các bước

- [ ] Nhóm thanh bên, theo thứ tự: (không tên) Hôm nay, Gọi trợ lý, Trò chuyện · **Brain** · **Chăm khách** · **Marketing** · **Đội AI và hệ thống**.
- [ ] Thêm hai nhóm module `care` và `brain` vào `NavGroup` và vào `category` của `module.json`. Giữ sáu nhóm cũ để module hiện có không hỏng. Ánh xạ hiển thị: `sales` vào Chăm khách, `marketing` và `studio` vào Marketing, `finance`, `ops`, `other` vào một nhóm "Khác" thu gọn.
- [ ] Các mục lõi ít dùng (Chợ Agent, Gói Team, Skills, Bộ nhớ, Đề xuất cải tiến, Chi phí AI, Ngân sách AI, Nhật ký, Module) gom vào một mục "Nâng cao" thu gọn mặc định. Không xoá đường dẫn nào.
- [ ] Mục chưa có trang (Gọi trợ lý, Đồ thị) trỏ tới một trang giữ chỗ nói rõ "chưa làm".
- [ ] Thanh ra lệnh: bộ chọn bot (danh sách agent đang bật), nút mic (vô hiệu, có chú thích "sắp có"), nút đính kèm, ô nhập, nút gửi. Gửi thì tạo một cuộc trò chuyện mới với bot đã chọn qua API trò chuyện sẵn có (`docs/dev/API.md`) rồi chuyển sang `/chat/<id>`.
- [ ] Trang nào có ô soạn riêng (Trò chuyện, Hộp thư) thì ẩn thanh ra lệnh. Cho trang khai báo điều này qua một thuộc tính của route, không viết cứng tên trang trong khung.
- [ ] Màn Hôm nay: khối "Cần bạn" đọc `GET /api/attention` (đã có, `HomeDashboard.tsx:115-147`), làm mới theo `useEvents(['attention'])`. Khối "AI đã tự làm" đọc các lượt chạy thành công trong ngày. Khối "Đội AI" đọc danh sách agent và việc đang chạy. Widget của module vẫn hiện qua slot `dashboard`.
- [ ] Giữ chủ đề sáng: mọi màu mới phải có giá trị ở cả hai chế độ.

## Test

- Test thành phần cho `nav.ts`: mọi đường dẫn cũ vẫn có trong menu hoặc trong "Nâng cao".
- Test khung: route khai `hideCommandBar` thì thanh ẩn.
- `npm run build` và `npm run typecheck` qua.
- Chạy `?mock=1`: mở được từng trang cũ, không lỗi trong console.

## Xong khi

- Menu đúng năm nhóm. Bật, tắt một module thì mục của nó hiện, ẩn mà không tải lại bản dựng.
- Gõ một câu vào thanh ra lệnh, sang được trang trò chuyện có câu đó.
- Ở bề ngang điện thoại, thanh bên thu lại thành ngăn kéo; không có thanh cuộn ngang.

## Ghi chú

- Phông "Inter" đang được khai nhưng không đóng gói. Thêm file phông vào bản dựng hoặc bỏ tên; đừng tải từ mạng lúc chạy.
- Không đổi tên biến màu hiện có trong khối `@theme`: các module đang dùng.
