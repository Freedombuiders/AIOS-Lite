# Hướng dẫn sử dụng AIOS-Lite

AIOS-Lite là hệ điều hành agent chạy trên máy của bạn. Bạn giao việc cho các agent AI (Claude, Codex, Grok, Hermes), cho chúng dùng chung bộ nhớ, Second Brain và skill. Bạn bật thêm module khi cần: chăm sóc khách qua Zalo/Gmail, Facebook, quảng cáo, tài chính, KOL, video. Mọi thứ chạy trong một tiến trình Node trên máy bạn, dữ liệu nằm trong thư mục `data/`.

**Góp ý, báo lỗi, đề xuất tính năng:** gửi email về **tony@tranvanhoang.com**.

Mục lục:

1. [Cài đặt lần đầu](#1-cài-đặt-lần-đầu)
2. [Khoá bí mật và file .env](#2-khoá-bí-mật-và-file-env)
3. [Đăng nhập các CLI agent](#3-đăng-nhập-các-cli-agent)
4. [Tổng quan](#4-tổng-quan)
5. [Giao việc, lịch định kỳ, trò chuyện](#5-giao-việc-lịch-định-kỳ-trò-chuyện)
6. [Agents và phân quyền](#6-agents-và-phân-quyền)
7. [Skills, Second Brain, Bộ nhớ](#7-skills-second-brain-bộ-nhớ)
8. [Module: thêm, gỡ, cài đặt](#8-module-thêm-gỡ-cài-đặt)
9. [Từng module](#9-từng-module)
10. [Kết nối và Integrations](#10-kết-nối-và-integrations)
11. [Chi phí AI, Chợ Agent, Gói Team, Đề xuất](#11-chi-phí-ai-chợ-agent-gói-team-đề-xuất)
12. [Cài đặt hệ thống và Dừng khẩn cấp](#12-cài-đặt-hệ-thống-và-dừng-khẩn-cấp)
13. [Sao lưu và chuyển máy](#13-sao-lưu-và-chuyển-máy)
14. [Xử lý sự cố](#14-xử-lý-sự-cố)

---

## 1. Cài đặt lần đầu

Cần **Node.js 22** trở lên (`node -v`).

```bash
git clone <địa chỉ repo> AIOS-Lite
cd AIOS-Lite
npm install
cp .env.example .env
npm run build
npm start
```

Mở http://127.0.0.1:4380. Lần chạy đầu, app tự tạo khoá mã hoá `AIOS_ENCRYPTION_KEY` trong `.env` (xem mục 2).

Khi sửa code, dùng `npm run dev` (giao diện ở http://localhost:5173, API ở cổng 4380, tự tải lại khi lưu file). Khi chạy bản build, sau mỗi lần sửa code hoặc thêm module phải chạy lại `npm run build` rồi `npm start`.

Chạy thử không cần khoá nào: agent `demo` dùng runtime giả lập `mock`, không tốn tiền.

## 2. Khoá bí mật và file .env

- Mọi khoá bí mật chỉ nằm trong file **`.env`** ở thư mục gốc. File này đã có trong `.gitignore`, **không bao giờ commit** nó.
- `.env.example` liệt kê đủ các biến, tất cả để trống. Biến nào để trống thì tính năng dùng khoá đó tắt.
- Khoá nhập trên giao diện (Kết nối › Integrations, Cài đặt module) được mã hoá bằng `AIOS_ENCRYPTION_KEY` và lưu trong `data/aios.db`. Thư mục `data/` cũng không lên git.
- **Giữ kỹ `AIOS_ENCRYPTION_KEY`.** Mất khoá này thì không đọc lại được khoá API, tin Zalo, thư Gmail đã lưu.
- Khoá không bao giờ được đưa vào prompt của agent hay vào nhật ký. Agent gọi dịch vụ ngoài qua công cụ của AIOS-Lite, không cầm khoá.

| Biến | Dùng cho |
|---|---|
| `AIOS_ENCRYPTION_KEY` | Mã hoá dữ liệu nhạy cảm (tự tạo nếu trống) |
| `AIOS_TOKEN` | Bắt buộc mọi lời gọi API kèm token (nên đặt nếu mở app ra mạng nội bộ) |
| `COMPOSIO_API_KEY` | Facebook Page, Meta Ads, Gmail (module marketing, ads, gmail, kol) |
| `GOOGLE_API_KEY` | Gemini, Veo (module kol, video) |
| `OPENAI_API_KEY`, `FAL_KEY`, `ELEVENLABS_API_KEY`, `HEYGEN_API_KEY` | Tạo ảnh, giọng, video (module kol, video) |

## 3. Đăng nhập các CLI agent

AIOS-Lite không tự gọi API của mô hình. Nó chạy các CLI agent mà bạn đã cài và đăng nhập:

| Runtime | Cài | Đăng nhập |
|---|---|---|
| Claude Code | `npm i -g @anthropic-ai/claude-code` | `claude` rồi `/login`, hoặc `ANTHROPIC_API_KEY` |
| Codex | `npm i -g @openai/codex` | `codex login` |
| Grok Build | theo hướng dẫn của xAI | `grok login` |
| Hermes | theo hướng dẫn của Hermes | `hermes model` |

Vào **Hệ thống › Cài đặt**, bảng **Runtime** cho biết CLI nào dùng được. **Kiểm tra lại** thì miễn phí. **Kiểm tra thật** gửi một câu "hello" qua từng CLI, có thể tốn một lượt gọi.

## 4. Tổng quan

Trang đầu tiên khi mở app.

- **Cần bạn:** những gì chờ bạn xử lý: việc chờ duyệt, việc lỗi, lệnh integration chờ duyệt, cảnh báo của module. Bấm ✓ để đánh dấu đã xử lý.
- **Chọn kỳ 7 / 30 / 90 ngày** ở góc phải. Mọi con số đều kèm so sánh với kỳ liền trước.
- **Doanh thu & chi phí** (module Tài chính): doanh thu từ ERP, Whop, đơn Pancake; chi phí quảng cáo Meta, AI, sổ thu chi; lợi nhuận ước tính khớp trang P&L; ROAS. Nguồn nào chưa kết nối sẽ ghi rõ và có link để kết nối.
- **Hiệu quả nội dung** (module Marketing): số bài đã đăng, lượt tiếp cận, tương tác, tỉ lệ tương tác, bình luận và số bình luận AI đã trả lời, top 5 bài, kết quả theo từng Page.
- **Bán hàng qua Zalo** (module Zalo): khách nhắn tin, khách mới, tỉ lệ được trả lời trong 24 giờ, thời gian phản hồi, phần AI trả lời, khách đang chờ. Mặc định chỉ tính chat 1-1, bật "Gồm cả nhóm" nếu cần.
- **Theo dõi nhanh:** các thẻ nhỏ của module (khách đang chờ, nháp chờ duyệt, bài sắp đăng, báo cáo Radar mới nhất).

Khối nào trống nghĩa là module đó chưa được thêm hoặc chưa có dữ liệu. App không bao giờ tự bịa số; chưa biết thì ghi "—".

## 5. Giao việc, lịch định kỳ, trò chuyện

- **Công việc:** bấm **Tạo việc**, chọn agent, viết yêu cầu. Việc đi qua các trạng thái *Chờ → Đang chạy → Chờ duyệt / Xong / Lỗi*. Mở một việc để xem từng lượt chạy, câu trả lời, chi phí, bình luận. Bình luận vào việc sẽ gọi agent làm tiếp.
- Agent có thể tự chia việc con cho agent khác, tự ghi nhớ điều quan trọng, hoặc dừng ở *Chờ duyệt* khi cần bạn xem. Những việc chờ bạn hiện ở **Cần bạn**.
- **Lịch định kỳ:** đặt lịch cron (ví dụ 8 giờ sáng mỗi ngày) để agent tự làm, như báo cáo, tổng hợp, kiểm tra.
- **Trò chuyện:** chat trực tiếp với một agent. Mỗi tin nhắn cũng là một việc, có chi phí và nhật ký như việc thường.

## 6. Agents và phân quyền

- **Agents:** danh sách agent. Mỗi agent khai báo trong `agents/<id>/agent.yaml` (runtime, model, quyền) và `persona.md` (vai trò, cách làm việc). Sửa trên giao diện hay sửa file đều được.
- Tab **Quyền** của từng agent: thư mục Second Brain được đọc/ghi, bộ nhớ chung/riêng, skill, kết nối MCP, quyền trong từng module, mức quyền với từng integration (*Tắt, Chỉ đọc, Hỏi trước, Đọc & ghi*).
- Mặc định agent **không có quyền gì**. Mọi hành động ra ngoài (gửi Zalo, email, đăng Facebook) mặc định chỉ là **nháp** chờ bạn duyệt.
- Huy hiệu *Chặn cứng* nghĩa là CLI chặn thật; *Chỉ dặn trong prompt* nghĩa là CLI đó không chặn được, chỉ nhắc agent.

## 7. Skills, Second Brain, Bộ nhớ

- **Skills:** thư viện kỹ năng (mỗi skill là một thư mục có `SKILL.md`). Bảng skill × agent cho bạn chọn agent nào được dùng skill nào. Thêm thư mục skill ở đây.
- **Second Brain:** các thư mục ghi chú (có thể trỏ vào vault Obsidian của bạn). Agent tìm kiếm trong đó khi làm việc, chỉ trong thư mục được cấp quyền.
- **Bộ nhớ:** những điều ngắn agent cần nhớ lâu (giờ làm việc, sở thích, quy ước). Bộ nhớ chung của cả đội hoặc riêng từng agent. Bạn thêm, sửa, ghim được.

## 8. Module: thêm, gỡ, cài đặt

Vào **Hệ thống › Module**.

- **Thêm:** bật module. Menu của module hiện ngay, không cần khởi động lại. Có thể kèm các agent mẫu của module.
- **Cài đặt:** mở các công tắc và thông số của module (ví dụ cho phép tự gửi, cho phép đăng bài, địa chỉ ERP). Khoá bí mật nhập ở đây được mã hoá.
- **Gỡ (giữ dữ liệu):** tắt module, dữ liệu còn nguyên, thêm lại lúc nào cũng được.
- **Xoá dữ liệu:** chỉ khi đã gỡ; phải gõ đúng mã module để xác nhận. Không hoàn tác được.

Module nào cần điều kiện (ví dụ khoá Composio, hoặc module khác) thì thẻ module ghi rõ điều kiện còn thiếu.

## 9. Từng module

### Chăm sóc khách hàng (`care`)

Hộp thư chung cho mọi kênh (Zalo, Gmail…), menu **Sales**.

- **Hộp thư:** danh sách hội thoại, khung tin nhắn, ô trả lời và hồ sơ khách. Lọc theo *Chờ khách, Chưa giao, AI đang lo…*
- **Nháp chờ duyệt:** câu trả lời agent soạn sẵn. Duyệt, sửa, hoặc bỏ.
- **Khách hàng:** hồ sơ khách 360 (thông tin, nhu cầu, lịch sử đa kênh).
- **Kênh & agent:** gán agent phụ trách từng kênh/tài khoản và chế độ AI: *Tắt, Soạn nháp, Tự gửi*.
- **Cài đặt** của module: *Cho agent trả lời khách* (tắt là dừng khẩn cấp phần trả lời), *Cho phép chế độ Tự động gửi*, giờ nghỉ, độ trễ khi tự gửi.

Lời khuyên: bắt đầu với **Soạn nháp**, xem agent trả lời vài ngày rồi mới bật **Tự gửi**.

### Zalo (`zalo`)

- **Zalo · Tài khoản:** thêm nick bằng **quét QR** bằng app Zalo trên điện thoại. Phiên được lưu, khởi động lại app không phải quét lại.
- Tin nhắn mới tự vào **Hộp thư** của module Chăm sóc khách hàng.
- **Giới hạn của Zalo:** tin 1-1 trước lúc đăng nhập không lấy về được; lịch sử nhóm hiện bị Zalo từ chối. Mọi tin từ lúc đăng nhập trở đi đều được lưu.
- **Chống khoá nick:** mỗi nick có hạn mức theo ngày và theo từng 30 giây cho gửi tin, đọc nhóm, tra cứu. App tự chờ khi chạm hạn mức nhanh và dừng khi hết hạn mức ngày.
- **Mẫu tin, Gửi nhóm, Gửi 1-1, Sinh nhật:** chiến dịch gửi tin. Chỉ chạy khi bật *Cho phép chạy chiến dịch Zalo* trong Cài đặt module.
- Mỗi nick Zalo chỉ nên đăng nhập ở **một** app tại một thời điểm.

### Gmail (`gmail`)

Cần module Chăm sóc khách hàng và khoá Composio.

1. Kết nối Gmail trong Composio (hoặc bấm kết nối trong trang Gmail).
2. Trang **Gmail** › **Làm mới tài khoản** để lấy danh sách hộp thư, bật đồng bộ cho hộp thư cần dùng.
3. Bật *Bật đồng bộ Gmail* trong Cài đặt module.

App đọc thư mới mỗi 2 phút và đưa vào **Hộp thư**. Thư đến **trước** lúc bật đồng bộ không được đưa vào. Mỗi hộp thư chỉ nên có **một** kết nối trong Composio.

### Marketing Facebook (`marketing`)

- **Pages:** các Fanpage đã kết nối qua Composio.
- **Kho nội dung, Lịch đăng:** soạn bài, lên lịch, duyệt. Agent soạn bài thì bài nằm ở trạng thái chờ duyệt.
- **Phân tích:** số liệu từng bài và từng Page.
- **Bình luận AI, Quy tắc bình luận:** agent đọc bình luận và soạn hoặc gửi trả lời theo quy tắc.
- Cài đặt module: *Bật Content Studio*, *Cho phép tự đăng bài*, *Cho phép trả lời bình luận tự động*. Hai công tắc tự động mặc định **tắt**. Nếu một hệ thống khác đang trả lời bình luận cho cùng Page thì đừng bật, để khách không nhận trả lời trùng.

### Quảng cáo Meta (`ads`)

Chỉ đọc. Theo dõi chi tiêu, tin nhắn, CTR, CPM theo tài khoản và chiến dịch, chấm điểm bằng quy tắc, đặt **Mục tiêu**. Không bao giờ sửa quảng cáo trên Meta.

### Tài chính (`finance`)

- **P&L & dòng tiền:** doanh thu, chi phí, lợi nhuận theo kỳ, chia theo chương trình và quỹ Ads.
- **Mô hình kinh doanh, Sổ thu chi:** nhập chi phí trực tiếp và vận hành (lương, công cụ, mặt bằng) để lợi nhuận sát thực tế.
- **ERP:** đọc dữ liệu ERP qua MCP (chỉ đọc).
- Nguồn doanh thu: ERP (địa chỉ và token MCP trong Cài đặt module), Whop (MCP), đơn Pancake (Kết nối › Integrations). Nếu cùng một đơn có ở cả ERP và Pancake thì chỉ nên kết nối một nguồn, tránh tính trùng.
- Đặt **tỷ giá USD** cho chi phí AI và Whop.

### Radar thị trường (`radar`)

Mỗi ngày ba phiên: AI trong nước (7h), Thế giới (12h), Ngành nghề (20h). Mặc định **tắt lịch**, bật *Bật quét theo lịch* trong Cài đặt module, hoặc bấm **Chạy ngay**. Chọn kênh theo dõi ở **Kênh & lịch**. Một số nguồn cần khoá (Apify, RSSHub) ở Kết nối › Integrations.

### KOL Studio (`kol`)

KOL ảo giữ nguyên khuôn mặt: tạo hồ sơ (thông tin, ngoại hình, tính cách, bộ ảnh khuôn mặt), tạo ảnh/video, thư viện, bài đăng đa nền tảng. Bài đăng Facebook đi qua module Marketing và phải được duyệt. Có hạn mức chi theo ngày, tháng và từng KOL. Cần khoá Gemini, fal, Higgsfield hoặc ChatGPT (qua `codex login`).

### AI Video Studio (`video`)

Dựng video quay sẵn (cắt, phụ đề, chỉnh), viết kịch bản và sản xuất video cùng KOL (HeyGen, Veo, fal, Pexels), xem trước bằng HyperFrames. Cần **ffmpeg** (`brew install ffmpeg` trên macOS). Agent đạo diễn phải có quyền `studio.write`.

## 10. Kết nối và Integrations

Vào **Hệ thống › Kết nối**.

- **Integrations:** Pancake, Botcake, Composio + Google, Pexels, Freesound, ElevenLabs, FPT.AI, cùng các integration do module mang vào (fal, Higgsfield, HeyGen, Apify…). Nhập key, bấm **Lưu & kiểm tra**: chỉ lưu khi kiểm tra đạt.
- **Chờ duyệt:** lệnh ghi mà agent xin chạy ở mức *Hỏi trước*. Bấm **Duyệt**, **Duyệt luôn lệnh y hệt** (lần sau tự chạy) hoặc **Từ chối**. Lệnh xoá hoặc huỷ luôn phải duyệt.
- **MCP & khoá:** các máy chủ MCP trong `config/connections.yaml`. File này chỉ ghi **tên biến** trong `.env`, không ghi khoá thật.

## 11. Chi phí AI, Chợ Agent, Gói Team, Đề xuất

- **Chi phí AI › Sử dụng:** chi phí theo agent, runtime, ngày. Chỉ tính lượt chạy mà CLI báo giá.
- **Chi phí AI › Ngân sách:** hạn mức tháng cho từng agent. Gần chạm hạn mức thì có cảnh báo ở **Cần bạn**; đã chạm thì việc mới của agent đó dừng với lỗi "ngân sách" cho tới tháng sau hoặc khi bạn nâng hạn mức.
- **Chợ Agent:** mẫu agent dựng sẵn. Xem trước rồi **Cài vào đội**, chọn runtime lúc cài.
- **Gói Team:** cả nhóm agent dựng sẵn (persona, skill, lịch). Cài xong, agent ở chế độ an toàn, chưa có quyền gì, lịch để tắt; bạn cấp quyền theo hướng dẫn trong gói. Gói không bao giờ chứa khoá.
- **Đề xuất cải tiến:** hệ thống tự xem việc lỗi, chi phí, skill, module để gợi ý. Không có gì thay đổi cho tới khi bạn bấm **Áp dụng**.

## 12. Cài đặt hệ thống và Dừng khẩn cấp

- **Dừng khẩn cấp:** bật để ngừng giao việc mới cho mọi agent. Việc đang chạy vẫn tiếp tục tới khi xong hoặc bạn huỷ.
- **Giao diện:** Tối, Sáng hoặc theo hệ thống.
- **Mã truy cập:** nếu máy chủ đặt `AIOS_TOKEN`, nhập token ở đây (lưu trong trình duyệt này).
- **Nhật ký:** mọi hành động quan trọng (ai, làm gì, lúc nào) để tra lại.

## 13. Sao lưu và chuyển máy

Cần giữ ba thứ:

1. File **`.env`** (có `AIOS_ENCRYPTION_KEY`).
2. Thư mục **`data/`** (cơ sở dữ liệu `aios.db`, media, phiên Zalo).
3. Thư mục **`agents/`**, **`config/`**, **`skills/`** nếu bạn đã sửa.

Chuyển sang máy khác: cài như mục 1, chép ba thứ trên vào, rồi `npm run build && npm start`. Thiếu đúng khoá mã hoá thì dữ liệu đã mã hoá không đọc được.

## 14. Xử lý sự cố

| Hiện tượng | Cách xử lý |
|---|---|
| Cổng 4380 đang bận | Đổi `AIOS_PORT` trong `.env`, hoặc tắt tiến trình đang giữ cổng (`lsof -ti tcp:4380`). |
| Sửa code mà không thấy thay đổi | Chạy lại `npm run build`, khởi động lại `npm start`, tải lại trang. |
| Runtime báo "Chưa dùng được" | Đăng nhập lại CLI đó (mục 3) rồi bấm **Kiểm tra lại** ở Cài đặt. |
| Zalo không nhận tin | Xem trạng thái nick ở Zalo · Tài khoản; nếu hết phiên thì quét QR lại. Nick đang đăng nhập ở app khác có thể bị đẩy ra. |
| Gmail không có thư mới | Kiểm tra *Bật đồng bộ Gmail* trong Cài đặt module và hộp thư đã bật đồng bộ. Thư trước lúc bật không được lấy. |
| Một khối trên Tổng quan trống | Module chưa được thêm, nguồn dữ liệu chưa kết nối, hoặc kỳ đang chọn chưa có số liệu. |
| Agent không làm gì | Xem **Cần bạn** và trang việc: có thể đang chờ duyệt, thiếu quyền, hết ngân sách, hoặc đang bật Dừng khẩn cấp. |

Cần thêm trợ giúp hoặc muốn góp ý: **tony@tranvanhoang.com**.
