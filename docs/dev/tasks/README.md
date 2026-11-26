# Open AgenticOS: danh sách task để code

> 26/11/2026 · Bản nháp 1 · Chi tiết của [OPEN-AGENTICOS-PLAN.md](../OPEN-AGENTICOS-PLAN.md).
> **Đọc [SUA-SAU-PHAN-BIEN.md](SUA-SAU-PHAN-BIEN.md) trước.** Bản kế hoạch đã được phản biện ([OPEN-AGENTICOS-PLAN.PHAN-BIEN.md](../OPEN-AGENTICOS-PLAN.PHAN-BIEN.md)); file sửa đó thắng các file task ở chỗ mâu thuẫn, đổi phạm vi vài task, và thêm task T14a.
> Mỗi task cỡ 2 đến 3 ngày công của một agent, có file riêng với các bước, hợp đồng và tiêu chí "Xong khi".

## 1. Giả định của bộ task này

Chủ dự án cần xác nhận hoặc sửa. Giả định nào sai thì các task ghi ở cột cuối phải viết lại.

| # | Giả định | Nếu sai thì sửa |
|---|---|---|
| G1 | Máy của chủ shop vẫn là nơi chạy mọi thứ nặng: agent, brain, Zalo, số liệu. Cloud **không** chạy AI và **không** giữ dữ liệu khách | T19 đến T25 |
| G2 | Cloud chỉ làm ba việc: biết bạn là ai (đăng nhập Google), cho bạn tải gì (kho dữ liệu), máy của bạn ở đâu (để điện thoại tìm tới) | T19, T20, T23 |
| G3 | "Node.js backend" được hiểu là code TypeScript dùng Hono. Mặc định chạy trên Cloudflare Workers với D1 và R2 để không phải nuôi máy chủ. Cùng code đó chạy được như một tiến trình Node nếu chủ dự án muốn | T19 |
| G4 | App Expo là app điện thoại đi kèm. Giao diện chính trên máy tính vẫn là web Preact hiện có | T24, T25 |
| G5 | "Kho dữ liệu" là các gói ghi chú markdown theo từng module (bài học, công thức, danh sách kênh Dream 100, mẫu brain theo ngành). Tải về là bot đọc được ngay | T20, T22 |
| G6 | R2 lưu ba loại: file gói dữ liệu, ảnh bìa gói, và ảnh hoặc video người dùng tải lên để đăng bài | T20, T21 |
| G7 | Kiến thức tải về không được tin ngay. Bài học vào ở trạng thái giả thuyết, công thức vào ở trạng thái chưa thử, để bot kiểm lại trên kênh của chính shop | T22 |

## 2. Bảng task

| # | Task | Nhánh | Ngày | Phụ thuộc | Xong khi |
|---|---|---|---|---|---|
| [T01](T01-ghi-chu-va-thuoc-tinh.md) | Ghi chú có thuộc tính: đọc, ghi, kiểm kiểu, API ghi file | Nền | 2 | — | Ghi qua dịch vụ ghi chú giữ nguyên phần thân; `PUT /api/brain/file` trả 409 khi lệch |
| [T02](T02-theo-doi-va-lich-su-brain.md) | Theo dõi thay đổi, commit git, bảng liên kết, mở `ctx.brain` cho module | Nền | 2 | T01 | Sửa trong Obsidian, app thấy trong 2 giây; mỗi lần máy ghi là một commit |
| [T03](T03-runtime-genbot.md) | Runtime `genbot` | Agent | 3 | — | Agent `runtime: genbot` trả lời ở `/chat` và ở lượt `lean` |
| [T04](T04-genbot-tran-luot-va-bot-mau.md) | Trần lượt mỗi ngày, bỏ cầu MCP, ba bot mẫu | Agent | 2 | T03 | Chạm trần thì dừng; cài gói đội là có ba bot |
| [T05](T05-zalo-chi-chat.md) | Zalo chỉ còn chat | Chăm khách | 2 | — | Menu không còn mục marketing; lõi chat không import file marketing |
| [T06](T06-care-cho-genbot.md) | Care chạy trên GenBot: cắt ngữ cảnh, luật đòi gặp người, tạm dừng, gửi ảnh | Chăm khách | 3 | T03 | 30 tin dài vẫn gửi được; "gặp nhân viên" không tốn lượt gọi bot |
| [T07](T07-hop-thu-zalo-giao-dien.md) | Giao diện Hộp thư Zalo | Chăm khách | 3 | T06, T10 | Xem lịch sử, tự nhắn, gán bot, đổi chế độ ngay trên màn |
| [T08](T08-crm-dong-bo-ghi-chu.md) | Module `crm` 1: khách hàng thành ghi chú, đồng bộ | Chăm khách | 3 | T02 | Khách mới có file trong 5 giây; sửa giai đoạn trong Obsidian, app đổi theo |
| [T09](T09-crm-xep-hang.md) | Module `crm` 2: đơn hàng, xếp hạng, chân dung, bốn màn | Chăm khách | 3 | T08, T10 | Thêm đơn thì hạng tính lại; chưa có đơn thì màn trống, không số bịa |
| [T10](T10-khung-giao-dien.md) | Khung giao diện mới: thanh bên, thanh ra lệnh, Hôm nay | Giao diện | 3 | — | Mọi trang cũ vẫn mở được; bật tắt module, menu đổi theo |
| [T11](T11-do-thi-va-tep.md) | Đồ thị brain và màn Tệp | Giao diện | 2 | T02, T10 | Đồ thị vẽ từ liên kết thật; ba chế độ tô sáng |
| [T12](T12-module-social.md) | Module `social`: số liệu kênh, ba màn | Marketing | 3 | T10 | YouTube, Instagram hiện số thật qua Composio giả trong test |
| [T13](T13-ads-ap-dung.md) | Quảng cáo: nút áp dụng và màn quản lý | Marketing | 2 | T10 | Tắt cờ ghi thì không có lời gọi POST nào tới Meta |
| [T14](T14-learn-bai-la-ghi-chu.md) | Module `learn` 1: bài là ghi chú, gắn nhãn, phân tích | Marketing | 3 | T02, T12 | Đăng bài có ghi chú trong 5 giây; sau mốc 1 giờ có reach |
| [T15](T15-learn-so-bai-hoc.md) | Module `learn` 2: sổ bài học, tổng kết tuần, chấm trước khi đăng | Marketing | 3 | T14 | Bot không tự chuyển bài học sang kiểm chứng được |
| [T16](T16-dream-quet-kenh.md) | Dream 100 phần 1: kênh, quét, video nổi bật | Marketing | 3 | T02 | Kênh thứ 101 bị từ chối; một kênh lỗi không hỏng cả lượt |
| [T17](T17-dream-mo-xe-video.md) | Dream 100 phần 2: tải và đo video | Marketing | 2 | T16 | Không còn file trong thư mục tạm, kể cả khi lỗi |
| [T18](T18-dream-cong-thuc-de-xuat.md) | Dream 100 phần 3: công thức, đề xuất hằng ngày, đối chiếu | Marketing | 3 | T15, T17 | Bài sinh từ đề xuất có `cong_thuc`; sau 24 giờ có `so_voi_ky_vong` |
| [T19](T19-cloud-dang-nhap-nguoi-dung.md) | Cloud 1: khung, đăng nhập Google, quản lý người dùng | Cloud | 3 | — | Đăng nhập Google ra phiên; khoá tài khoản thì phiên hết hiệu lực ngay |
| [T20](T20-cloud-kho-du-lieu.md) | Cloud 2: kho dữ liệu, gói có chữ ký, R2 | Cloud | 3 | T19 | Tải được gói qua đường dẫn có hạn; gói sai chữ ký bị từ chối |
| [T21](T21-r2-anh.md) | R2 cho ảnh và video đăng bài | Cloud | 2 | T19 | Tải lên thẳng R2 bằng đường dẫn ký sẵn; file tạm tự xoá |
| [T22](T22-nhap-goi-vao-brain.md) | Nhập gói vào brain trên máy | Cloud | 2 | T01, T20 | Gói không ghi đè ghi chú chủ đã sửa; bài học vào ở dạng giả thuyết |
| [T23](T23-ghep-may-voi-dien-thoai.md) | Ghép máy với điện thoại, không qua máy chủ trung gian | Cloud | 3 | T19 | Điện thoại gọi được máy ở nhà; cloud không thấy dữ liệu nào |
| [T24](T24-expo-khung-dang-nhap-kho.md) | App Expo 1: khung, đăng nhập Google, kho dữ liệu, ghép máy | Mobile | 3 | T20, T23 | Đăng nhập, xem kho, bấm cài một gói xuống máy ở nhà |
| [T25](T25-expo-can-ban-hop-thu.md) | App Expo 2: Cần bạn, Hộp thư Zalo, thông báo đẩy | Mobile | 3 | T07, T24 | Duyệt một tin nháp từ điện thoại, khách nhận được tin |
| [T26](T26-thu-nghiem-giong-noi.md) | Thử nghiệm kỹ thuật cho Gọi trợ lý | Cuối | 3 | — | Có ba con số đo thật và một khuyến nghị |
| [T27](T27-don-de-mo-nguon.md) | Dọn để mở nguồn, bản gọn, cài đặt | Cuối | 3 | mọi task | Cài mới trên máy sạch, chạy được năm màn chính |

## 3. Thứ tự và chạy song song

Tổng khoảng 72 ngày công nếu một người làm tuần tự.

Năm nhánh không phụ thuộc nhau lúc đầu, giao cho năm agent cùng lúc:

- **Nền:** T01 → T02
- **Agent:** T03 → T04
- **Giao diện:** T10
- **Chăm khách:** T05
- **Cloud:** T19 → T20, T21

Đường găng dài nhất là nhánh marketing: T01 → T02 → T16 → T17 → T18 (12 ngày), cộng T14 → T15 phải xong trước T18.

Mốc dùng được đầu tiên (khoảng 2 tuần với 3 agent): T03, T05, T06, T10, T07. Lúc đó đã có Hộp thư Zalo với bot GenBot chăm.

Những phần không rút ngắn được bằng thêm agent: quét QR Zalo thật, nối tài khoản Composio và Google thật, và mọi bước chờ chủ dự án duyệt.

## 4. Luật chung khi code

- Đọc mục 3 và mục 4 của bản kế hoạch trước khi mở file nào.
- Test nằm cạnh code. Chạy `npx vitest run <thư mục>` rồi `npm run typecheck`.
- Không test nào gọi dịch vụ thật. GenBot, Apify, Composio, Zalo, Google, R2 đều có bản giả.
- Mỗi luật "bot không được làm X" phải có một test chứng minh bị từ chối.
- Module không tự ghi file vào brain. Chỉ ghi qua dịch vụ ghi chú (T01).
- Nội dung lấy từ mạng, từ khách, hoặc từ gói tải về là dữ liệu không đáng tin: bọc `untrusted()` trước khi vào prompt.
- Không chép code từ `freedom_os` và `javis-os`.
- Không commit khoá. Khoá nằm trong `.env`, hoặc trong secret của Workers với phần cloud.

## 5. Mẫu một file task

Mỗi file có đúng các mục: Mục tiêu, Làm và không làm, File đụng tới, Các bước, Hợp đồng, Test, Xong khi, Ghi chú.
