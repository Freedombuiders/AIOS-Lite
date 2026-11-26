# Nối AIOS với GenBot

Hướng dẫn này nối một agent AIOS với một bot trong GenBot qua Bot API. Sau khi nối, mọi lượt chạy của agent (trả lời ở `/chat`, soạn trả lời khách Zalo, viết bài…) đi qua bot GenBot đó.

Gói đội **Đội AgenticOS mặc định** (`teams/agenticos-doi-mac-dinh/`) dựng sẵn ba agent GenBot: Bot CSKH, Bot Nội dung, Bot Trợ lý. Cài gói ở trang Đội, rồi làm các bước dưới đây cho từng bot.

## Trước khi bắt đầu: bot GenBot biết những gì

Luồng mở qua Bot API bị nhốt: không chạy lệnh, không MCP, không ứng dụng nối, không đọc ghi file. Bot chỉ trả lời bằng chữ, từ ba nguồn:

1. Phần ngữ cảnh AIOS gửi kèm mỗi lượt (đã lọc theo quyền brain của agent).
2. Chỉ dẫn thường trực của bot trong GenBot.
3. Bộ nhớ đã lưu của bot trong GenBot.

Nguồn 2 và 3 **nằm ngoài** quyền brain của AIOS. AIOS không lọc được chúng. Vì thế:

- Dùng **một bot GenBot riêng cho mỗi cửa hàng hoặc công ty**. Đừng dùng chung một bot cho hai công ty: bot có thể nhắc lại điều nó nhớ của công ty kia.
- Nên dùng một bot riêng cho mỗi vai trò (CSKH, Nội dung, Trợ lý), mỗi bot một khoá.

## Bước 1. Tạo bot và bật Bot API trong GenBot

1. Mở app GenBot, tạo bot mới (ví dụ "CSKH Trà Sen Việt"). Chọn AI chạy nhốt được (Claude, Codex hoặc AI dùng khoá API). AI không chạy nhốt được sẽ làm Bot API trả `403`.
2. Mở bánh răng của bot › Nâng cao › Truy cập › **Bot API**, bật **Let apps talk to this bot**.
3. Thẻ hiện lệnh mẫu kèm khoá. **Chép khoá ngay**: GenBot chỉ hiện khoá một lần. Mất khoá thì bấm **New key** để tạo khoá mới (khoá cũ ngừng chạy).
4. Ghi lại **mã bot** (`bot_id`): phần nằm giữa `/hooks/api/bots/` và `/messages` trong địa chỉ của lệnh mẫu.

GenBot Cloud gói Starter không có Bot API.

## Bước 2. Chép khoá vào `.env`

Mở file `.env` ở thư mục gốc AIOS, thêm một dòng cho mỗi bot. Tên biến phải bắt đầu bằng `GENBOT_KEY_`:

```
GENBOT_KEY_CSKH=khoá-của-bot-cskh
GENBOT_KEY_NOI_DUNG=khoá-của-bot-nội-dung
GENBOT_KEY_TRO_LY=khoá-của-bot-trợ-lý
```

Khởi động lại AIOS để nạp khoá.

Không dán khoá vào `agent.yaml` hay vào form agent. AIOS chỉ lưu **tên biến** (`key_env`). Khoá được giữ kín: không agent CLI nào (Claude, Codex, Grok, Hermes) thấy được các biến `GENBOT_KEY_*`, và khoá bị che trong nhật ký và thông báo lỗi.

## Bước 3. Điền thông tin vào agent

Mở agent ở trang Agents. Với runtime **GenBot**, form có ba ô:

| Ô | Ví dụ | Ghi chú |
|---|---|---|
| Địa chỉ GenBot (`base_url`) | `http://127.0.0.1:8800` | Cổng nhận webhook của GenBot. `http://` chỉ dùng khi GenBot chạy trên cùng máy; GenBot ở máy khác phải là `https://` |
| Mã bot (`bot_id`) | `bot_abc123` | Lấy ở bước 1 |
| Biến chứa khoá (`key_env`) | `GENBOT_KEY_CSKH` | Tên biến ở bước 2, không phải khoá |

Bấm **Kiểm tra**. AIOS kiểm đủ ba ô, có khoá trong `.env`, kết nối được tới GenBot, rồi gửi một tin "ping" thật. Cả bốn dòng phải là "Được". Lưu agent.

Sửa trực tiếp `agents/<id>/agent.yaml` cũng được:

```yaml
runtime: genbot
runtime_options:
  base_url: http://127.0.0.1:8800
  bot_id: bot_abc123
  key_env: GENBOT_KEY_CSKH
  max_runs_day: 500
```

## Bước 4. Thử

- Nhắn agent ở `/chat`. Trong app GenBot sẽ thấy một luồng mới, đánh dấu gửi qua Bot API. Mỗi lượt là một luồng mới, nên danh sách luồng trong GenBot sẽ dài dần.
- Với Bot CSKH: ở Zalo › Agent chăm, gán bot ở chế độ **Nháp** trước. Đọc nháp vài ngày, khi yên tâm mới chuyển sang Tự động.

## Giới hạn cần biết

| Giới hạn | Hệ quả |
|---|---|
| 10 lượt gọi mỗi phút cho một bot | AIOS tự xếp hàng; chờ quá thời gian cho phép thì lượt đó báo "hết hạn mức" |
| 20.000 ký tự mỗi tin | AIOS tự rút gọn ngữ cảnh (bỏ bớt skill, bộ nhớ, brain, lịch sử cũ). Dữ liệu module không bị cắt; quá dài thì việc báo lỗi cấu hình để bạn chia nhỏ |
| GenBot không báo chi phí | Ngân sách tiền không chặn được. Mỗi agent có trần `max_runs_day` (mặc định 500 lượt mỗi ngày) |
| Không gửi ảnh, PDF | Tin chỉ có ảnh sẽ không được bot xem. Việc cần nhìn ảnh nên giao cho agent chạy runtime khác |
| Bot hỏi xin duyệt | Lượt đó dừng, mục "Cần bạn" hiện mã luồng; mở app GenBot để trả lời trong luồng đó |

## Khi có lỗi

| Thông báo | Cách xử lý |
|---|---|
| Biến môi trường `GENBOT_KEY_…` chưa có khoá | Thêm khoá vào `.env`, khởi động lại AIOS |
| GenBot 401 | Khoá sai hoặc đã bị thay bằng New key: chép khoá mới vào `.env` |
| GenBot 403 | Bot API đang tắt, sai `bot_id`, gói Cloud Starter, hoặc AI của bot không chạy nhốt được |
| Không kết nối được GenBot | Mở app GenBot; kiểm địa chỉ và cổng ở `base_url` |
| `base_url` dùng http:// chỉ được trỏ về máy này | Dùng `https://` cho GenBot ở máy khác |
| GenBot trả chuyển hướng | Sửa `base_url` thành địa chỉ cuối (AIOS không theo chuyển hướng để khoá không đi sang máy khác) |
| Đã chạm trần … lượt chạy mỗi ngày | Chờ sang ngày mới, hoặc tăng `max_runs_day` |
