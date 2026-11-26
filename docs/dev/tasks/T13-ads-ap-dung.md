# T13 · Quảng cáo: nút áp dụng và màn quản lý

> Nhánh Marketing · 2 ngày · Phụ thuộc: T10 · Kế hoạch mục 5.5.2 · Cần chủ dự án xác nhận Q6

## Mục tiêu

Chủ shop bấm một nút để làm theo đề xuất của máy luật: tạm dừng, hoặc tăng ngân sách. Không gì tự chạy.

## Bản vẽ tham chiếu

`Ads.dc.html`, `AdsManage.dc.html`.

## File đụng tới

| File | Việc |
|---|---|
| `modules/ads/module.json` | Cài đặt `writeEnabled` (mặc định `false`), `minResultsPerWeek` (mặc định 10) |
| `modules/ads/server/accounts.ts:188` | Xin thêm `ads_management` khi `writeEnabled` bật |
| `modules/ads/server/graph-tools.ts` | Hai lệnh ghi qua `graphProxy` |
| `modules/ads/server/apply.ts` | MỚI |
| `modules/ads/server/rules.ts` | Ngưỡng 50 kết quả mỗi tuần thành cài đặt |
| `modules/ads/web/` | Màn Tổng quan, Quản lý |

## Các bước

- [ ] Đọc `rules.ts` (R1 đến R5, `THRESHOLDS`) và `fb_ads_recommendations` trước. Hiện module không ghi gì lên Meta (`rules.ts:3`, `worker.ts:4`).
- [ ] Lệnh ghi: `pauseEntity(id)` (đặt trạng thái tạm dừng cho chiến dịch hoặc nhóm quảng cáo) và `setDailyBudget(adsetId, amount)`. Số tiền gửi theo đơn vị nhỏ nhất của tiền tệ; dùng lại phần đổi đơn vị sẵn có trong `metrics.ts:252-261`.
- [ ] `POST /api/m/ads/recommendations/:id/apply` với các rào, kiểm theo thứ tự:
  1. `writeEnabled` bật, nếu không trả 409 kèm lời hướng dẫn.
  2. Đề xuất còn `pending` và chưa quá 48 giờ.
  3. Đọc lại trạng thái hiện tại từ Meta. Số liệu làm căn cứ cũ hơn 2 giờ thì từ chối và yêu cầu chụp lại.
  4. Với tăng ngân sách: tối đa 20% so với hiện tại, và chưa có lần tăng nào cho nhóm quảng cáo này trong 3 ngày (đọc từ nhật ký).
  5. Gọi Meta. Đọc lại để xác nhận giá trị mới.
  6. `ctx.audit.log` với giá trị trước và sau; đánh dấu đề xuất đã xử lý.
- [ ] **Không** đăng ký hai lệnh ghi thành `ModuleAction` hay thành lệnh integration. Chỉ đường HTTP của chủ gọi được.
- [ ] Hai nút còn lại: "Tôi đã tự xử lý" và "Bỏ qua 24 giờ" (đã có logic 24 giờ, 48 giờ trong module; dùng lại).
- [ ] Màn Quản lý: hàng đề xuất, mục tiêu (giá mục tiêu, ngân sách tháng), danh sách luật có công tắc, và bộ chọn mức quyền. Ở mức chỉ đọc, nút chính là "Mở Ads Manager".
- [ ] Màn Tổng quan: tám chỉ số, chi tiêu mỗi ngày, nhịp ngân sách tháng, bảng chiến dịch. ROAS hiện "chưa tính được" khi chưa có giá trị mua hàng.
- [ ] Chiến dịch chưa có giá mục tiêu: máy luật không đề xuất, màn hiện lời nhắc đặt mục tiêu.

## Test

- `writeEnabled` tắt: gọi `apply` trả 409 và `graphProxy` giả không nhận lời gọi POST nào.
- Tăng 25% bị từ chối. Tăng lần hai trong 3 ngày bị từ chối.
- Số liệu cũ 3 giờ bị từ chối.
- Meta trả lỗi: đề xuất vẫn `pending`, có dòng nhật ký lỗi, không báo thành công.
- Tìm trong code: không có `ModuleAction` nào trỏ tới `apply.ts` (test kiến trúc).

## Xong khi

- `npx vitest run modules/ads` qua.
- Với tài khoản quảng cáo thử: tạm dừng một chiến dịch thử, thấy trạng thái đổi trong Ads Manager.

## Ghi chú

Không thêm tạo chiến dịch, sửa nhắm đối tượng hay sửa mẫu quảng cáo. Ba việc đó rủi ro tiêu tiền cao và nằm ngoài yêu cầu.
