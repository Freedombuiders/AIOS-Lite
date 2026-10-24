---
name: finance-ledger
description: Đọc tóm tắt tài chính tháng và ghi khoản thu chi vào Sổ thu chi của module Tài chính. Dùng khi chủ hỏi về lãi lỗ, dòng tiền tháng này hoặc nhờ ghi một khoản thu / chi.
---

# Sổ thu chi (finance-ledger)

Khối "Tài chính tháng" ở đầu yêu cầu là dữ liệu đã tính sẵn: P&L tháng (ERP, Whop, quảng cáo, chi phí AI) và số liệu sổ thu chi. Đọc khối đó trước khi trả lời.

## Ghi một khoản vào sổ

Cần quyền `finance.write`. Kết thúc câu trả lời bằng đúng một khối:

```
<aios-action module="finance" name="ledger.add">{"kind":"overhead","amount":1500000,"note":"Phí hosting tháng 10","date":"2026-10-24"}</aios-action>
```

- `kind`: `revenue` (doanh thu), `refund` (hoàn tiền), `direct` (chi phí trực tiếp), `overhead` (vận hành), `tax` (thuế), `investment` (đầu tư), `financing` (vốn bổ sung), `ad_payment` (trả quảng cáo), `other_ads` (Ads ngoài Meta).
- `amount`: số tiền lớn hơn 0, đơn vị theo sổ (thường VND).
- `note`: ghi chú ngắn, bắt buộc.
- Tuỳ chọn: `date` (YYYY-MM-DD, mặc định hôm nay), `productId`, `cash`, `cashDate`.

Nếu hệ thống trả lỗi, đọc lỗi tiếng Việt, sửa payload và nói rõ với chủ khoản nào chưa được ghi. Không ghi trùng một khoản hai lần.
