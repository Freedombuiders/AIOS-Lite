# Báo cáo đêm 26/11/2026: Open AgenticOS

> Viết lúc tắt máy. Kế hoạch: [OPEN-AGENTICOS-PLAN.md](OPEN-AGENTICOS-PLAN.md) · Phản biện: [OPEN-AGENTICOS-PLAN.PHAN-BIEN.md](OPEN-AGENTICOS-PLAN.PHAN-BIEN.md) · Sửa sau phản biện: [tasks/SUA-SAU-PHAN-BIEN.md](tasks/SUA-SAU-PHAN-BIEN.md).

## Đã lên `main` và đã push

| Task | Nội dung |
|---|---|
| T01, T02 | Ghi chú có thuộc tính, ghi nguyên tử, theo dõi thay đổi, commit git gộp, liên kết, `ctx.brain.notes` |
| T03, T04 | Runtime `genbot` qua Bot API, khoá không lọt sang agent khác, trần độ dài prompt, trần lượt mỗi ngày, gói ba bot mẫu |
| T05 | Zalo chỉ còn chat, marketing tắt ở mọi điểm khởi động |
| T06 | Chăm khách an toàn: khách đòi gặp người thì dừng hẳn, tạm dừng có hạn, tin chỉ có ảnh chuyển cho chủ, mặc định chỉ soạn nháp, gom tin liên tiếp |
| T07 | Màn Hộp thư Zalo ba cột, bảng gán bot |
| T08 | Mỗi khách thành một ghi chú, một chiều từ app ra file |
| T09 | Ba màn khách hàng chỉ đọc (Giai đoạn, Tất cả khách, Hồ sơ) |
| T10 | Khung giao diện mới: thanh bên, thanh ra lệnh, Hôm nay |
| T12 | Màn Mạng xã hội, chỉ Facebook |
| T14a, T14 | Dòng dõi bài đăng, sửa lỗi bài nhân đôi; mỗi bài Facebook thành một ghi chú có số đo theo mốc |
| T15 | Sổ bài học, tổng kết tuần, chấm bài nháp trước khi đăng |
| D1, D2 | Dream 100 bản thu nhỏ: chủ dán link video, máy tải, đo, phân tích; công thức do chủ duyệt; đề xuất hằng ngày; đối chiếu kết quả với công thức |
| T19, T20, T21 | Cloud (Workers, D1, R2): đăng nhập Google, quản lý người dùng, kho gói có chữ ký, tải ảnh lên R2 |
| T22 | Cài gói dữ liệu vào brain, nút đăng nhập cloud trong app |
| T24 (phần đầu) | App Expo: đăng nhập Google, xem kho dữ liệu, cài đặt tài khoản |
| S1 | Quyền chủ: agent không tự duyệt bài; mọi việc gửi, duyệt, đăng, cài gói đòi danh tính chủ |

Kiểm tra trên `main` cuối cùng (`046a0ce`): `typecheck` qua; 4.761 test qua, 13 hỏng. Cả 13 đã hỏng sẵn trước khi bắt đầu: `web/src/lib/api.test.ts` x5 và `quick-api.test.ts` x5 (localStorage trên Node 25), `creation.test.ts` x1 (ffmpeg), `recos.test.ts` x2. Cloud 108/108.

## Tự quyết đêm qua (vì bạn ngủ), theo đề xuất của bản phản biện

- Bản đầu chỉ Facebook cho dashboard và vòng học.
- Khách hàng chỉ xuất một chiều, chưa xếp hạng, chưa có đơn hàng.
- Dream 100 không quét Apify hằng ngày; chủ dán link.

## Chưa làm, cần bạn xác nhận

- Ghi lên tài khoản quảng cáo Meta (T13).
- Ghép điện thoại với máy ở nhà (T23, T25): mở một cổng của máy ra Internet.
- Đồ thị brain (T11), Gọi trợ lý bằng giọng nói (T26).
- Dọn để mở nguồn (T27): cần bạn xác nhận nguồn gốc code từng module.
- CRM hai chiều, xếp hạng khách, đơn hàng.

## Cần bạn quyết

- Bảng loại ghi chú mỗi gói được mang (worker cloud tự chọn; xem `cloud/README.md`).
- Luật tự xoá ảnh cũ trên R2: khoá file hiện không có tiền tố riêng cho ảnh đăng bài; hai phương án ở `cloud/README.md`.
- "treg" là gì.
- Có ẩn ô nhắn tin trong cuộc chat nhóm Zalo không.

## Chưa thử với tài khoản thật

GenBot thật (ba bot, khoá trong `.env`), Zalo thật, Fanpage Facebook thật, Google OAuth thật, deploy Cloudflare thật, app trên điện thoại thật. Các luồng đều đã chạy với bản giả hoặc dữ liệu mẫu.

## Giới hạn đã biết

- Agent chạy dưới cùng tài khoản máy vẫn đọc được `.env` và kho cookie của trình duyệt (xem `docs/dev/OWNER-AUTH.md`).
- Chưa chặn quyền chủ cho các đường chỉ tiêu tiền: tạo ảnh và video ở KOL, dựng video, lịch chạy, giao việc.
- Tên và số điện thoại khách nằm dạng chữ thường trong ghi chú và trong lịch sử git.
- Ảnh trong gói dữ liệu mới được kiểm, chưa được cài.
