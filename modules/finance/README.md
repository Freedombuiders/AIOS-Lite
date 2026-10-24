# Tài chính (finance)

Module tài chính của AIOS-Lite, chuyển từ bản của chủ. Gồm bốn màn hình trong nhóm menu **Tài chính**:

| Màn hình | Đường dẫn | Nội dung |
|---|---|---|
| P&L & dòng tiền | `/m/finance/pnl` | Báo cáo lãi lỗ tháng/tuần/tuỳ chọn, theo chương trình, phân bổ quảng cáo, so sánh kỳ trước |
| Mô hình kinh doanh | `/m/finance/business-model` | Canvas 9 ô và 5 tham số, bản nháp lưu trong trình duyệt, xuất/nhập JSON |
| Sổ thu chi | `/m/finance/ledger` | Sổ doanh thu, chi phí, dòng tiền, danh mục sản phẩm |
| ERP | `/m/finance/erp` | Số liệu ERP đã đồng bộ (chỉ đọc) |

Widget bảng điều khiển: **Thu chi tháng này**.

## Nguồn dữ liệu

- **ERP (Frappe qua MCP)**: đặt trong Module › Tài chính › Cài đặt, bằng địa chỉ MCP + token, hoặc một lệnh MCP cục bộ. Mỗi 15 phút module đọc tóm tắt kinh doanh. Module chỉ gọi được 10 công cụ đọc (`ERP_READ_TOOLS` trong `server/erp/sync.ts`); công cụ khác bị chặn trước khi gửi đi.
- **Whop (tuỳ chọn)**: địa chỉ MCP + token, chỉ gọi `accounts_list` và `stats_time-series_get`.
- **Quảng cáo Meta**: đọc từ bảng của module `ads` nếu đã Add. Chưa có thì P&L hiển thị cảnh báo thiếu dữ liệu.
- **Chi phí AI**: tổng `cost_usd` của bảng `runs` theo ngày giờ Việt Nam.

## Cho agent

- Quyền `finance.read`: agent nhận khối tóm tắt P&L tháng và sổ thu chi (dưới 3000 ký tự) trong mọi lượt chạy.
- Quyền `finance.write`: agent ghi một khoản vào sổ bằng `<aios-action module="finance" name="ledger.add">`. Số tiền phải lớn hơn 0, ghi chú bắt buộc, lỗi trả về tiếng Việt.
- Agent mẫu `finance-analyst` và skill `finance-ledger`.

## Dữ liệu

Bảng giữ tên của bản gốc: `erp_snapshots`, `erp_daily`, `erp_period_totals`, `pnl_whop_daily`. Thêm `finance_kv` thay cho `dashboard_settings` (cài đặt P&L, sổ thu chi, lịch sử chi quảng cáo đã lưu).

## Chạy thử

`npx vitest run modules/finance`. Test không gọi mạng; ERP và Whop dùng connector giả.
