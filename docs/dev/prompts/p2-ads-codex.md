Bạn là worker Codex. Làm module `ads` (task ADS-01…ADS-06 trong docs/dev/TASKS.md Phần 2).
Đọc docs/dev/prompts/p2-common.md và làm đúng quy trình trong đó (có bảng sở hữu file; bạn chỉ được ghi trong phạm vi của mình). Module id: ads; manifest: docs/dev/port/ads.json; SQL: các phần @fbstudio-*:ads (riêng getZaloCustomerCare, saveZaloCustomerCare và zaloThreadHasCustomer thuộc zalo, KHÔNG lấy).
Riêng ads:
- Chỉ đọc. Có test khẳng định không có lời gọi tool ghi nào sang Meta.
- requires.connections = ["composio"]; enhances = ["marketing"].
- Không import gì từ modules/marketing. Bài organic lấy qua ctx.modules.get('marketing')?.topPosts; không có marketing thì ẩn khối đó.
- Kiểu dùng chung đặt ở modules/_lib/fb-types.ts (phối hợp: nếu file đã có thì import, chưa có thì tạo, chỉ thêm không sửa).
Cuối cùng in báo cáo theo mẫu ở BRIEF.md.
