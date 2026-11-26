# T15 · Module `learn` 2: sổ bài học, tổng kết tuần, chấm trước khi đăng

> Nhánh Marketing · 3 ngày · Phụ thuộc: T14 · Kế hoạch mục 5.6.3 đến 5.6.6

## Mục tiêu

Khép vòng học: bài học có trạng thái và bằng chứng, bot dùng bài học đã kiểm chứng, và mỗi tuần có một bản tổng kết kèm kế hoạch.

## Bản vẽ tham chiếu

`Loop.dc.html`, `Playbook.dc.html`, `Weekly.dc.html`, `Learn.dc.html`, và ô "Khớp sổ bài học" trong `Content.dc.html`.

## File đụng tới

`modules/learn/server/playbook.ts`, `weekly.ts`, `score-draft.ts`, `metrics.ts`, `migrations/002_weekly.sql`, `web/` (bốn trang), và `modules/marketing/web/` (ô chấm trong màn soạn bài, qua `useProvides`).

## Các bước

**Sổ bài học**

- [ ] `playbook.ts` giữ máy trạng thái của ghi chú `bai-hoc` (sơ đồ ở mục 5.6.3). Mọi chuyển trạng thái đi qua một hàm `transition(ref, to, actor)`.
- [ ] Luật trong `transition`:
  - `gia-thuyet → dang-thu`: cần ít nhất 3 bằng chứng. Máy tự chuyển và nêu mục cần chú ý.
  - `dang-thu → da-kiem-chung`: `actor` phải là `owner`. Bất kỳ `actor` nào khác bị từ chối.
  - `dang-thu → bi-bac-bo`: máy đề xuất khi đủ số bài thử (cài đặt, mặc định 4) mà ER trung vị không cao hơn trung vị kênh; chủ xác nhận.
  - `da-kiem-chung → dang-thu`: máy tự chuyển khi 5 bài gần nhất làm theo đều dưới trung vị.
- [ ] Agent đề xuất bài học mới qua một `ModuleAction` `learn.propose` (scope `learn.propose`): tạo ghi chú `gia-thuyet`. Không có action nào đổi trạng thái.
- [ ] Bằng chứng là liên kết tới ghi chú thật. Liên kết trỏ tới file không tồn tại thì không được tính.
- [ ] `agentContext` của module: với agent có trong `dung_boi`, chèn tối đa 10 bài học `da-kiem-chung`, tổng 1.500 ký tự, bọc `untrusted`.

**Hai thước đo**

- [ ] ER trung vị theo tuần, từ các ghi chú `bai-dang`.
- [ ] Tỷ lệ nháp gửi nguyên theo tuần, từ `care_delivery_intents`. Đọc `persistence/outbox-store.ts:543-583` để biết chính xác `payload_revision` và `approved_revision` nghĩa là gì trước khi viết câu truy vấn. Lấy số qua một hàm `care` cung cấp, không đọc thẳng bảng của module khác.

**Tổng kết tuần**

- [ ] `ctx.schedule.every('weekly', '30 7 * * 1', …)`. Bảng `learn_weekly(year, week, rel_path, PRIMARY KEY(year, week))`.
- [ ] Lúc khởi động: nếu tuần trước chưa có dòng thì viết bù. Hẹn giờ của module không chạy bù khi máy tắt.
- [ ] Code gom số liệu; một lượt agent viết phần "cái được, cái hỏng" từ số liệu đó; ghi `tong-ket/<năm>-tuan-<số>.md`.
- [ ] "Đề xuất tuần này" là danh sách có ô đánh dấu trong ghi chú. `POST /api/m/learn/weekly/:year/:week/approve` nhận các dòng được chọn, tạo việc qua `ctx.tasks.create`.

**Chấm trước khi đăng**

- [ ] `POST /api/m/learn/score-draft` với `{ text, format, scheduledAt, hasVideo }`. Phần kiểm được bằng code (giờ đăng, định dạng, độ dài) kiểm bằng code. Kiểu mở đầu dùng một lượt `lean`, có bộ nhớ đệm theo băm của nội dung.
- [ ] Ô "Khớp sổ bài học x/y" trong màn soạn bài.

**Màn**

- [ ] Vòng học tổng quan, Sổ bài học, Chờ duyệt (đề xuất ghi nhớ và đề xuất chuyển trạng thái), Tổng kết tuần.

## Test

- `transition` với `actor` là id agent sang `da-kiem-chung`: bị từ chối. Đây là test bắt buộc.
- Bằng chứng thứ ba đẩy sang `dang-thu` và nêu mục cần chú ý.
- Bài học kiểm chứng có 5 bài gần nhất dưới trung vị: quay về `dang-thu`.
- Khởi động sau khi lỡ sáng thứ Hai: ghi chú tuần được viết đúng một lần.
- `score-draft` cùng nội dung gọi hai lần chỉ tốn một lượt agent.

## Xong khi

- `npx vitest run modules/learn` qua.
- Duyệt một kế hoạch tuần tạo đúng số việc đã chọn ở trang Việc.

## Ghi chú

Bài học tới từ gói tải về (T22) luôn vào ở `gia-thuyet`, không bao giờ vào thẳng `da-kiem-chung`.
