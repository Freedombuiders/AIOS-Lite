Bạn là worker Codex. Làm module `gmail` (task GMAIL-01…GMAIL-05 trong docs/dev/TASKS.md Phần 2).
Đọc docs/dev/prompts/p2-common.md và làm đúng quy trình trong đó (có bảng sở hữu file; bạn chỉ được ghi trong phạm vi của mình). Module id: gmail; manifest: docs/dev/port/gmail.json; SQL prefix: email.
Riêng gmail:
- requires.modules = ["care"], requires.connections = ["composio"].
- Connector Gmail implement hợp đồng trong modules/_lib/care-kit (import từ đó). Kênh Gmail đăng ký vào care qua ctx.modules.get('care').careChannels.register(...) theo DECISIONS §5.
- Đồng bộ 2 phút một lần, chỉ xét thư đến sau thời điểm bật.
- Bỏ các bảng integration_* và mcp_hub* khỏi phần SQL tách ra.
Cuối cùng in báo cáo theo mẫu ở BRIEF.md.
