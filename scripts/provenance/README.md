# Provenance guard (chống lẫn mã ClaudeClaw gốc)

- Giấy phép upstream ClaudeClaw cấm phân phối lại mã của họ; AIOS-Lite chỉ được chứa mã do chủ dự án viết.
- `upstream-index.txt` chứa hash (sha1, 16 ký tự) của mọi cửa sổ 8 dòng liên tiếp "có nghĩa" trong `upstream/main`; không thể suy ngược ra mã.
- Dòng tầm thường (ngắn < 12 ký tự, chỉ dấu câu, import/export-from, comment ngắn) bị bỏ qua; mỗi dòng được trim và gộp khoảng trắng.
- Tạo lại index: `node scripts/check-provenance.mjs --build-index [--source <gốc>]`.
- Kiểm tra: `node scripts/check-provenance.mjs` (exit 1 nếu có trùng, in `file:dòng` kèm cửa sổ).
- Cũng fail nếu chuỗi "ZaloCRM" xuất hiện ngoài `modules/zalo/`, `docs/`, `scripts/` (ZaloCRM là AGPL).
- Dương tính giả đã duyệt: thêm `path:dòng` hoặc hash vào `scripts/provenance/allow.txt` (dòng `#` là ghi chú).
- Bỏ qua: node_modules, dist, web/dist, data, workspaces, .git, scripts/provenance.
- Nên chạy trước mỗi commit/CI; chạy < 20 giây.
- Đừng port file có ở upstream: dùng `scripts/port/copy.mjs`, nó tự từ chối.
