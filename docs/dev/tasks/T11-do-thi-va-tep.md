# T11 · Đồ thị brain và màn Tệp

> Nhánh Giao diện · 2 ngày · Phụ thuộc: T02, T10 · Kế hoạch mục 5.4 việc 5

## Mục tiêu

Nhìn thấy brain như một mạng ghi chú, và biết bot đang dùng ghi chú nào, chỗ nào còn thiếu.

## Bản vẽ tham chiếu

`Graph.dc.html`, `Files.dc.html`.

## File đụng tới

| File | Loại |
|---|---|
| `src/api/routes/brain.ts` | SỬA: thêm `GET /api/brain/graph`, `GET /api/brain/usage` |
| `src/core/migrations/00X_brain_usage.ts` | MỚI |
| `src/shared/context.ts:162-168` | SỬA: ghi lại ghi chú nào được đưa vào prompt |
| `web/src/pages/brain/GraphPage.tsx`, sửa trang Tệp sẵn có | MỚI, SỬA |

## Các bước

- [ ] `GET /api/brain/graph?folder=`: trả `{ nodes: [{ path, title, dir, loai }], edges: [{ from, to }] }` từ `brain_docs` và `brain_links`. Liên kết trỏ tới ghi chú không tồn tại thì bỏ.
- [ ] Bảng `brain_usage(folder_id, path, agent_id, day, hits, misses, PRIMARY KEY(folder_id, path, agent_id, day))`.
- [ ] Trong `context.ts`, sau khi chọn các kết quả tìm brain cho một lượt chạy, tăng `hits` cho từng ghi chú. Ghi theo lô, không chặn lượt chạy.
- [ ] "Còn thiếu": module nào biết bot thiếu kiến thức thì báo qua một hàm lõi mới `brain.reportMiss(folderId, path | null, agentId, question)`. Bản này chỉ tạo hàm và bảng; nơi gọi đầu tiên là `learn` (T15) và `care`.
- [ ] `GET /api/brain/usage?day=`: tổng `hits`, `misses` theo ghi chú.
- [ ] Trang Đồ thị: vẽ bằng canvas. Bố cục tính ở trình duyệt bằng mô phỏng lực đơn giản, chạy trong một worker để không giật. Màu theo thư mục cấp một. Kéo, phóng to, bấm chọn.
- [ ] Ba chế độ tô sáng: Tất cả, AI dùng hôm nay (theo `hits`), Còn thiếu (theo `misses`).
- [ ] Bấm một chấm hiện thẻ: tên, số liên kết, bot nào đọc hôm nay, nút mở ghi chú.
- [ ] Trang Tệp: thêm cột phải gồm bot nào đang dùng, quyền ghi (đọc từ `access.brain` của các agent), ghi chú nối tới đây (`backlinks`), lịch sử (`history`) kèm nút hoàn tác.
- [ ] Có bảng thay thế cho người dùng trình đọc màn hình: danh sách ghi chú và số liên kết.

## Test

- API đồ thị với thư mục mẫu trả đúng số chấm, số cạnh.
- Một lượt chạy `mock` làm tăng `hits` của đúng các ghi chú được chèn.
- Test thành phần: đổi chế độ thì tập chấm sáng đổi.

## Xong khi

- Đồ thị 2.000 ghi chú kéo được mượt trên máy thường (đo bằng số khung hình khi kéo, ghi kết quả vào báo cáo).
- Hoàn tác một thay đổi từ trang Tệp đưa nội dung về như cũ.

## Ghi chú

Không thêm thư viện đồ thị nặng. Nếu cần thư viện, chọn một cái nhỏ và nêu lý do trong báo cáo.
