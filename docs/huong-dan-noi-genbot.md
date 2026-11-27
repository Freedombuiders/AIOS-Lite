# Nối AIOS với GenBot

**GenBot là động cơ duy nhất của Open AgenticOS.** Mọi agent là một bot GenBot (quyết định của chủ ngày 27/11: "chỉ dùng genbot agent, không dùng bot dạng khác"). Các động cơ cũ (Claude Code, Codex, Grok, Hermes) đã bị xoá khỏi code (G3), cùng Chợ Agent cũ và trang Agents chung. Một `agent.yaml` cũ còn ghi tên các động cơ đó vẫn được nạp nhưng không chạy, và hiện "Agent X đang dùng …, hãy chuyển sang GenBot" cho tới khi bạn bấm **Chuyển sang GenBot** (AIOS không tự sửa hay xoá `agent.yaml` của bạn).

Hướng dẫn này nối một bot AIOS với một bot trong GenBot qua Bot API. Sau khi nối, mọi lượt chạy của bot (trả lời ở `/chat`, soạn trả lời khách Zalo, viết bài…) đi qua bot GenBot đó. Mọi việc làm ở màn **Đội AI · Bot** (thanh bên, mục ĐỘI AI VÀ HỆ THỐNG).

Gói đội **Đội AgenticOS mặc định** (`teams/agenticos-doi-mac-dinh/`) dựng sẵn ba bot: Bot CSKH, Bot Nội dung, Bot Trợ lý. Có thể cài gói ở trang Gói Team, hoặc thêm từng bot ở Đội AI · Bot bằng mẫu CSKH Zalo, Nội dung, Trợ lý (quyền brain và quyền module điền sẵn theo gói). Mọi agent đi kèm repo (`agents/`, `modules/*/agents/`, `teams/`) đều là bot GenBot với mã bot để trống, nên hiện "Chưa nối GenBot" cho tới khi bạn điền. Thư mục `agents/` của repo có sẵn ba bot của gói này (`bot-cskh`, `bot-noi-dung`, `bot-tro-ly`, quyền trên brain mẫu `cong-ty-b`): chỉ cần **Sửa** (mã bot) và **Đổi khoá** trên thẻ. Việc hay cuộc trò chuyện không chỉ định bot sẽ về Bot Trợ lý nếu nó có khoá, không thì về bot đầu tiên có khoá. Nút **Lượt chạy, quyền** trên thẻ mở lượt chạy, cuộc trò chuyện và quyền brain/module của bot (`/agents/<id>`).

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

## Bước 2. Thêm bot ở màn Đội AI · Bot

1. Mở **Đội AI · Bot**. Ở ô **Kết nối GenBot**, kiểm địa chỉ GenBot (mặc định `http://127.0.0.1:8800`) rồi bấm **Kiểm tra**: AIOS kết nối thử tới GenBot (không tạo hay đổi gì trong GenBot).
2. Bấm **Thêm bot GenBot**. Chọn mẫu (CSKH Zalo, Nội dung, Trợ lý), đặt tên, vai trò, chọn thư mục brain, điền **mã bot** và **dán khoá** chép ở bước 1.
3. Bấm **Kiểm tra rồi lưu**. AIOS gửi một tin "ping" thật tới bot và hiện câu trả lời; được thì lưu. Chưa được thì xem lỗi (bảng cuối trang), sửa rồi thử lại, hoặc bấm **Vẫn lưu**.

Chưa có mã bot hoặc khoá thì vẫn lưu được: bot hiện "Chưa nối GenBot", điền sau bằng **Sửa** và **Đổi khoá** trên thẻ của bot.

**Khoá được giữ thế nào.** Khoá lưu mã hoá trong AIOS (bằng khoá `AIOS_ENCRYPTION_KEY`, cùng chỗ với khoá integration), theo từng bot. Không API nào trả khoá về: màn hình chỉ hiện "Đã có khoá" và 4 ký tự cuối. Khoá không được ghi vào `agent.yaml`, `.env`, nhật ký hay sự kiện (bị che thành `[redacted]`), và không bao giờ vào môi trường của tiến trình con. **Đổi khoá** thay khoá cũ; **Xoá** bot xoá luôn khoá. Đặt hay đổi khoá, địa chỉ GenBot, mã bot đều cần quyền chủ (phiên chủ đã ghép hoặc `AIOS_TOKEN`).

Mỗi thẻ bot cho thấy: mã bot, trạng thái khoá, lần kiểm tra gần nhất, số lượt hôm nay so với trần `max_runs_day`, module nào đang dùng bot (phân công chăm khách, cài đặt learn/dream, Fanpage marketing), thư mục brain được đọc và ghi, và quyền module. Nút: **Kiểm tra**, **Sửa**, **Đổi khoá**, **Tạm dừng**, **Xoá** (hỏi lại trước khi xoá).

**Thiết lập cũ dùng `.env`.** Agent đã có `runtime_options.key_env: GENBOT_KEY_…` và khoá trong `.env` vẫn chạy (thẻ hiện "Khoá trong .env"). Khoá dán trong app được ưu tiên hơn. Nên chuyển: bấm **Đổi khoá**, dán khoá, rồi xoá dòng `GENBOT_KEY_…` khỏi `.env`.

## Bước 3. Sửa trực tiếp agent.yaml (không bắt buộc)

```yaml
runtime: genbot
context: lean            # hoặc standard
runtime_options:
  base_url: http://127.0.0.1:8800
  bot_id: bot_abc123
  max_runs_day: 500
```

Không có khoá trong file này. `http://` chỉ dùng khi GenBot chạy trên cùng máy; GenBot ở máy khác phải là `https://`.

## Bước 4. Thử

- Nhắn agent ở `/chat`. Trong app GenBot sẽ thấy một luồng mới, đánh dấu gửi qua Bot API. Mỗi lượt là một luồng mới, nên danh sách luồng trong GenBot sẽ dài dần.
- Với Bot CSKH: ở Zalo › Agent chăm, gán bot ở chế độ **Nháp** trước. Đọc nháp vài ngày, khi yên tâm mới chuyển sang Tự động.

## Giới hạn cần biết

| Giới hạn | Hệ quả |
|---|---|
| 10 lượt gọi mỗi phút cho một bot | AIOS tự xếp hàng; chờ quá thời gian cho phép thì lượt đó báo "hết hạn mức" |
| 20.000 ký tự mỗi tin | AIOS tự rút gọn ngữ cảnh (bỏ bớt skill, bộ nhớ, brain, lịch sử cũ). Dữ liệu module không bị cắt; quá dài thì việc báo lỗi cấu hình để bạn chia nhỏ |
| GenBot không báo chi phí | Ngân sách tiền không chặn được. Mỗi agent có trần `max_runs_day` (mặc định 500 lượt mỗi ngày) |
| Không gửi ảnh, PDF | Tin chỉ có ảnh sẽ không được bot xem; care chuyển tin đó cho chủ |
| Bot hỏi xin duyệt | Lượt đó dừng, mục "Cần bạn" hiện mã luồng; mở app GenBot để trả lời trong luồng đó |

## Khi có lỗi

| Thông báo | Cách xử lý |
|---|---|
| Chưa có khoá Bot API cho bot này | Đội AI · Bot › thẻ bot › **Đổi khoá**, dán khoá |
| GenBot 401 | Khoá sai hoặc đã bị thay bằng New key: bấm **Đổi khoá**, dán khoá mới |
| GenBot 403 | Bot API đang tắt, sai `bot_id`, gói Cloud Starter, hoặc AI của bot không chạy nhốt được |
| Không kết nối được GenBot | Mở app GenBot; kiểm địa chỉ và cổng ở `base_url` |
| `base_url` dùng http:// chỉ được trỏ về máy này | Dùng `https://` cho GenBot ở máy khác |
| GenBot trả chuyển hướng | Sửa `base_url` thành địa chỉ cuối (AIOS không theo chuyển hướng để khoá không đi sang máy khác) |
| Đã chạm trần … lượt chạy mỗi ngày | Chờ sang ngày mới, hoặc tăng `max_runs_day` |
| Agent X đang dùng Claude Code (Codex, Grok, Hermes), hãy chuyển sang GenBot | Động cơ đó đã bị xoá: bấm **Chuyển sang GenBot** ở mục "Agent dùng runtime cũ" của Đội AI · Bot, rồi điền mã bot và khoá |
| Chưa có bot GenBot nào có khoá (thanh lệnh hiện "Nối bot") | Đội AI · Bot › thẻ bot › **Sửa** (mã bot) và **Đổi khoá** |

## Tính năng đã tắt vì chỉ dùng GenBot

Bot GenBot chỉ trả lời bằng chữ, không đọc file, không tìm trên mạng. Các chỗ trước đây cần runtime khác đã tự tắt và báo rõ:

- **Radar: nguồn X** (cần Grok tìm trực tiếp trên X). Báo cáo ghi "Nguồn X đang tắt"; các nguồn khác vẫn chạy.
- **KOL Studio: "ChatGPT (Codex)" làm agent viết nội dung.** Chọn một bot GenBot thay thế. (Tạo ảnh bằng ChatGPT qua Codex là nhà cung cấp ảnh, không phải agent, nên vẫn giữ.)
- **Video Studio: tạo video bằng trò chuyện** (cần agent đọc file và chạy công cụ). Dựng video quay sẵn vẫn dùng được.
