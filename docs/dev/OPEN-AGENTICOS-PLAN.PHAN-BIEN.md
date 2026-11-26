# Phản biện kế hoạch Open AgenticOS

## Kết luận

Chưa đủ chắc để triển khai nguyên kế hoạch; chỉ nên bắt đầu một lát cắt GenBot → nháp care → chủ duyệt sau khi sửa các hợp đồng bên dưới.  
Vấn đề thứ nhất: “bot không tự gửi, đăng, chi tiền” chưa được cưỡng chế; cấu hình khoá GenBot còn làm lộ khoá sang các runtime con.  
Vấn đề thứ hai: vòng học đứt ngay ở lưu nguồn công thức, thông báo xuất bản và nối ID bài với số liệu; P6–P7 hiện chưa có đường dữ liệu khép kín.  
Vấn đề thứ ba: đồng bộ CRM hai chiều không có dữ liệu gốc để merge từng trường, có thể ghi đè thay đổi hợp lệ và tạo khách trùng sau sự cố.  
Runtime là điểm nối hợp lý cho GenBot, nhưng tuyên bố mọi caller runLean dùng được nguyên trạng là sai; có caller cần ảnh, tìm kiếm thật hoặc vượt trần prompt.  
Bản đầu nên giữ SQLite làm nguồn CRM, xuất ghi chú một chiều, chỉ hỗ trợ nội dung chữ và một đường Facebook có duyệt; hoãn quảng cáo ghi, voice, Dream 100 đầy đủ.  
Các kết luận dưới đây dựa trên đọc mã nguồn tại chỗ, không chạy app, test hay mạng; giấy phép nguồn ngoài và trường kết bạn của SDK chưa có đủ bằng chứng để xác nhận.

Quy ước: đường dẫn tương đối thuộc /Users/tonyhoang/orca/AIOS-Lite; tiền tố GenBot/ thuộc /Users/tonyhoang/orca/genbot. Dòng chứng cứ là dòng mã hiện có, không lấy số dòng trong kế hoạch làm bằng chứng. Đã đọc toàn bộ kế hoạch và cả hai file Bot API được yêu cầu.

## Lỗi sự thật

| Tuyên bố trong kế hoạch | Mã thực sự nói gì | Chứng cứ file:dòng |
|---|---|---|
| §3: fb_content có approval_required, nên đi qua bảng là đủ để không tự đăng | approval_required thuộc fb_pages; agent add có thể tự approve khi trang tắt yêu cầu duyệt. | modules/marketing/migrations/001_init.sql:9–19, :40–67; modules/marketing/server/core/agent-commands.ts:227–248 |
| §3: module dùng untrusted() hiện có | Hàm là helper nội bộ, không export; chỉ sinh chuỗi bao quanh dữ liệu, không phải rào thực thi quyền. | src/shared/context.ts:32–35 |
| §3.1: mọi module runLean chạy GenBot không phải sửa | Video director gửi ảnh; X collector cần tìm kiếm; core không bảo đảm tổng prompt ≤20.000. Chi tiết đủ 12 caller ở phát hiện 6. | modules/video/server/edit/agent/director.ts:619–660; modules/radar/server/collectors/x-grok.ts:33–53; src/shared/contracts.ts:134–136 |
| §5.1.1: runtime_options là bản ghi tự do | Giá trị chỉ là string, number hoặc boolean. Cấu hình ví dụ hợp lệ, nhưng object/array lồng nhau không hợp lệ. | src/agents/schema.ts:38 |
| §5.1.1: ví dụ agent CSKH chỉ cần care: [reply.send] | Agent-turn đòi reply.draft trước khi gọi model; reply.send là kiểm thêm cho tự gửi. Ví dụ không tạo được nháp. | modules/care/server/application/agent-turn.ts:318–319, :603–605 |
| §5.1.3: dạng GET chưa có trong tài liệu | Tài liệu đã mô tả đọc lại thread, working, needs_approval và reply; host xác nhận cùng hai dạng 200/202. | GenBot/desktop/docs/bot-api.md:49–60; GenBot/desktop/server/bot-api-host.ts:227–232 |
| §5.1.3: doctor kiểm cấu hình agent | Runtime.doctor chỉ nhận probe, không nhận agent/runtimeOptions; endpoint hiện gọi doctor trên runtime dùng chung. | src/runtimes/contracts.ts:91–97; src/runtimes/index.ts:10–14; src/api/routes/system.ts:26–31 |
| §5.1.4: policy cấp MCP cho mọi lượt không lean; dùng noTools để nhận diện runtime không có công cụ | Còn cần integrations, task ID, token factory và apiUrl. noTools nghĩa là “có thể chạy không công cụ”, không phải “chỉ chạy không công cụ”. | src/access/policy.ts:67–77; src/runtimes/contracts.ts:29–30 |
| §5.1.5: nhiều thread ngắn có thể làm chạm trần số hội thoại đồng thời | Thread đã kết thúc không chiếm pending cap. Trần đồng thời kiểm công việc đang chạy, không phải tổng thread lịch sử; lịch sử phình là vấn đề khác. | GenBot/desktop/server/bot-api-host.ts:111–124, :149, :169 |
| §5.2.2: endpoint AI nhận observe | Assignment dùng observe; endpoint /conversations/:id/ai nhận off, draft, auto. | modules/care/server/api/routes-workflow.ts:27, :79–83; modules/care/server/application/ingest.ts:484 |
| §5.2.2: tối đa 30 câu mỗi khách/ngày | Là maxRepliesPerThreadDay: giới hạn theo thread, không phải một customer trên mọi cuộc chat. | modules/care/server/policy/policy-ext.ts:54–66 |
| §5.2.2: care đã chỉ trả lời tin chữ | Gate cho phép ảnh không kèm chữ; runtime có đường ảnh/PDF theo capabilities. | modules/care/server/policy/message-gates.ts:135–144; modules/care/server/module-runtime.ts:142–148 |
| §5.2.3: ngữ cảnh hiện xấu nhất 30 × 2.000 = 60.000 ký tự | Còn trần 6.000 token ước lượng, khoảng 3 ký tự/token; vòng chọn tin thực thi trần. Tin trigger cũng đang bị rút ngắn nếu cần. | modules/care/server/application/agent-context.ts:32–39, :212–230 |
| §7 R3: care đã gom tin 3–12 giây | Đó là trễ gửi tự động sau khi model đã chạy. Ingest enqueue riêng theo từng message ID, không debounce bằng khoảng này. | modules/care/server/application/agent-turn.ts:586–630; modules/care/server/application/ingest.ts:486–498 |
| §5.2.3: kiểm eligibility trước khi xếp việc | maybeEnqueueTurn không gọi evaluateEligibility. Chỉ sửa eligibility không tạo ra điểm chặn trước enqueue được mô tả. | modules/care/server/application/ingest.ts:445–500 |
| §5.0.2: reindex({folderId}) “cho file đó” | API này quét cả folder; không có đối số file. Mtime bằng phần nguyên millisecond thì bỏ qua. | src/shared/brain.ts:213–229 |
| §4.2, §5.7.7: fb_content.id dạng fbc_… và lưu meta.cong_thuc/meta.hoc_tu | ID là INTEGER; không có cột meta. Writer lọc theo whitelist, không lưu trường tuỳ ý. Cũng đã có pillar/hook_type, không cần phát minh lại nhãn từ số không. | modules/marketing/migrations/001_init.sql:40–67; modules/marketing/server/store.ts:193–215 |
| §5.6.1: nghe sự kiện chuyển published; worker ghi mốc | Publisher cập nhật bảng và log, không emit sự kiện xuất bản ở nhánh thành công. Worker điều phối; sync gọi store UPSERT metrics, cũng không emit snapshot. | modules/marketing/server/core/publisher.ts:252–273; modules/marketing/server/analytics/worker.ts:82–105; modules/marketing/server/analytics/sync.ts:454; modules/marketing/server/store.ts:877–888 |
| §5.5.1: số liệu video tài khoản đã được đọc mỗi 30 phút | 30 phút là tick; nhịp snapshot thay đổi theo tuổi bài. Chỉ chọn kol_post_targets đã published có external_id trong cửa sổ 30 ngày, không phải mọi video của tài khoản. | modules/kol/server/metrics.ts:40–42, :58–68, :193–198 |
| §2: vòng học “chưa có gì” | Chưa có vòng công thức khép kín như đề xuất, nhưng đã có classifier/insight analytics, skill video-learn và director ghi taste. Không nên lập thêm lớp gắn nhãn mà bỏ những đường này. | modules/marketing/server/analytics/analyst.ts:291–299; modules/video/server/edit/agent/director.ts:665–673; modules/video/skills/video-learn/SKILL.md:50–58 |
| §0.2, §5.9: modules port từ FreedomOS thương mại được xem như một nguồn upstream | Hồ sơ repo phân biệt rõ mã chủ tự viết trong bản private với upstream không được đưa vào. Kế hoạch bỏ qua phân biệt này; cũng không thể coi lời tự khai là chứng nhận sở hữu độc lập. | THIRD_PARTY_NOTICES.md:62–72; modules/care/PORTING.md:3; modules/kol/PORTING.md:3; modules/radar/PORTING.md:3 |
| §5.9: khai license “AGPL-3.0” | NOTICE hiện ghi chính xác AGPL-3.0-only, cho toàn thư mục; nên giữ SPDX này. | modules/zalo/NOTICE:3–13 |

## Vấn đề thiết kế

### 1. Nghiêm trọng — Khoá GenBot trong .env sẽ lọt vào tiến trình agent khác

**Sai:** §5.1.1 chỉ tránh ghi vào YAML, chưa bảo vệ khoá trong tiến trình. loadEnvFile đưa tất cả biến vào process.env; buildChildEnv kế thừa mọi biến ngoài danh sách loại bỏ. GENBOT_KEY_CSKH không nằm trong danh sách đó.

**Kịch bản:** shop giữ Claude/Codex làm dự phòng đúng đề xuất Q2; agent có shell đọc môi trường, lấy khoá bot CSKH rồi hỏi Bot API về chỉ dẫn/bộ nhớ. GenBot tự cảnh báo khoá cho phép đọc các dữ liệu ấy qua câu trả lời. Không cần agent có quyền brain của AIOS.

**Chứng cứ:** src/core/env.ts:30–34; src/runtimes/shared.ts:15–45; GenBot/desktop/docs/bot-api.md:78–81; src/core/redact.ts:17–25.

**Sửa:** giải quyết quản lý credential trước P1: chỉ core adapter lấy secret; loại mọi tên key_env đã đăng ký khỏi môi trường con, kể cả các lớp override; đăng ký redaction theo giá trị. Chỉ cho HTTP loopback hoặc HTTPS tới endpoint đã cấu hình tin cậy; không theo redirect mang credential sang host khác. Dùng bot riêng có bộ nhớ được kiểm soát cho từng phạm vi khách hàng/công ty. Không diễn giải enforces.context=hard thành “mọi tri thức chỉ theo access.brain”: saved memory và standing instructions của GenBot nằm ngoài bộ lọc AIOS (GenBot/desktop/docs/bot-api.md:64–79).

### 2. Nghiêm trọng — “Không công cụ” không có nghĩa “không thể gửi, đăng hay chi”

**Sai:** §3 tuyên bố một bất biến chưa tồn tại. Engine thực thi ModuleAction sau khi kiểm scope, không có bước chủ duyệt chung. Lean không thực thi action directive, nhưng module vẫn lấy JSON từ lean rồi tự làm tác dụng bên ngoài. untrusted() chỉ là chuỗi prompt.

**Kịch bản:** nội dung khách hoặc video cấy chỉ dẫn vào prompt; care ở auto tạo reply rồi tự gửi; agent marketing có content.write thêm bài trên page approval_required=0 và tự approve. KOL tuỳ chọn cũng có autopilot tạo media trong ngân sách rồi tự duyệt/lên lịch nếu cấu hình cho phép. Đây là những hành vi đang được thiết kế cho phép, không phải lỗi vượt scope; kế hoạch phải thay chúng nếu muốn cam kết không hành động thiếu chủ.

**Chứng cứ:** src/work/engine.ts:108–140; src/shared/context.ts:32–35; modules/care/server/module-runtime.ts:134–138; modules/care/server/application/agent-turn.ts:586–605; modules/marketing/server/actions.ts:54–59; modules/marketing/server/core/agent-commands.ts:218–248; modules/kol/server/autopilot.ts:132–140, :191–202.

**Sửa:** chốt sản phẩm cho phép auto nào, rồi cưỡng chế cùng một chính sách tại nơi tạo/duyệt/gửi intent. Bản đầu chỉ nháp; duyệt gắn với nội dung, đích, revision và số tiền cụ thể. Các nguồn customer/scrape/note phải giữ nguồn gốc không tin cậy, scope tối thiểu; kết quả trích xuất không tự biến thành chỉ dẫn hay bài học đã kiểm chứng. Kiểm JSON đúng schema không chứng minh nội dung an toàn.

### 3. Cao — Đường HTTP quảng cáo không xác thực “chủ đã bấm”

**Sai:** §5.5.2 coi không đăng ký ModuleAction là đủ để agent không gọi được. API hiện chỉ kiểm token nếu cấu hình token; mặc định là không có token. Một runtime có shell có thể gọi localhost.

**Kịch bản:** bot dự phòng đọc một ghi chú nhiễm chỉ dẫn, gọi endpoint apply bằng HTTP trong cấu hình mặc định. Hai request đồng thời còn có thể cùng qua kiểm cooldown rồi cùng tăng 20% nếu không có khoá/transaction; kiểm số liệu mới hơn hai giờ không giải quyết chuyện này.

**Chứng cứ:** src/api/server.ts:60–67; src/core/config.ts:71–75; src/work/engine.ts:108–140. Endpoint mới chưa tồn tại, nên không có bằng chứng nó sẽ xác thực chủ hay chống lặp.

**Sửa:** xác thực principal chủ riêng, approval gắn payload và giá trị trước/sau, idempotency key, reservation/cooldown nguyên tử theo đối tượng ngân sách; đối chiếu lại trạng thái trước ghi. Hoãn mọi POST Meta khỏi bản đầu. Không quảng bá “HTTP-only” thành rào an toàn.

### 4. Cao — Đồng bộ hai chiều sẽ ghi đè thay đổi không hề xung đột

**Sai:** §5.3.3 muốn biết “hai bên cùng đổi một trường” nhưng crm_note_index chỉ lưu hash toàn dữ liệu, mtime và một revision; không có bản gốc từng trường để merge.

**Kịch bản cụ thể:** lúc đồng bộ, stage=consulting. Chủ chuyển stage sang won trong app; đồng thời sửa một câu ở thân note. Export thấy file đổi nên bỏ qua toàn bộ trường kinh doanh. Import thấy frontmatter cũ consulting và revision cũ; nếu giải quyết bằng “file thắng”, nó đưa khách từ won về consulting dù chủ chưa sửa stage trong Obsidian. Nếu giữ CAS và không retry thì sync mắc kẹt; kế hoạch chưa định nghĩa lối ra.

Profile và task có revision riêng, nên một db_revision của customer không theo dõi được “Khách cần gì”, việc tiếp theo hay hạn. Customer hiện cũng không có nguon, gia_tri, viec_tiep, han; mã stage tiếng Việt cần ánh xạ với enum new/consulting/quoted/deposit/won/lost.

**Chứng cứ:** docs/dev/OPEN-AGENTICOS-PLAN.md:496–530; modules/care/server/persistence/directory-stores.ts:65–105; modules/care/server/persistence/schema.ts:296–307, :582–605.

**Sửa:** bản đầu xuất một chiều SQLite → note, để phần thân do chủ viết riêng và không nhập ngược trường vận hành. Nếu làm hai chiều sau này, phải lưu merge base từng trường, phân biệt revision từng nguồn, merge chỉ các trường thực sự thay đổi và yêu cầu giải quyết xung đột có ý nghĩa nghiệp vụ. Hash không thay thế merge base.

### 5. Cao — Đồng bộ chưa có tính lặp an toàn, khôi phục sự cố và định danh

**Sai:** filesystem event được coi như giao dịch; id “không được sửa tay” chỉ là lời dặn. Mtime không phải khoá chống ghi đè. NotesService còn cho expectMtimeMs tuỳ chọn.

**Kịch bản:** tạo customer xong thì app chết trước khi ghi id vào note; lần chạy sau tạo thêm khách. Copy note mang cùng id sửa một khách từ hai file; sửa id sang khách khác có thể ghi nhầm người. App tự patch → watcher import → updateCustomer dù không đổi dữ liệu vẫn tăng revision → export lại cap_nhat, tạo vòng lặp. Chủ sửa file giữa kiểm mtime và ghi thì bị mất đoạn sửa. Git revert file khách trở thành một lệnh nhập dữ liệu cũ. Hai công ty có cùng khach-hang/lan.md đụng UNIQUE(rel_path) dù folder khác.

**Chứng cứ:** docs/dev/OPEN-AGENTICOS-PLAN.md:251–263, :496–530; modules/care/server/persistence/directory-stores.ts:31–42, :88–105, :110–116; src/shared/brain.ts:227. Mỗi listCustomers chỉ tối đa 500, không có cursor, nên expose list() nguyên xi còn bỏ khách khi bootstrap lớn.

**Sửa:** một chiều trước; nếu nâng cấp thì cần ID ổn định trước create, mapping bất biến folder+path↔customer, idempotent operation journal, bỏ update no-op, hash ngữ nghĩa, ghi file nguyên tử có kiểm bản đọc, startup reconciliation và pagination. Không coi git commit/revert là giao dịch SQLite+file. Conflict log và lịch sử git cũng giữ PII dạng rõ lâu dài; chính sách xoá/export/backup phải tính cả hai nơi.

### 6. Cao — Runtime đúng tầng, nhưng chưa có hợp đồng tương thích cho caller

**Đánh giá:** nên dùng Runtime để giữ chung task/run/audit/access; không tạo đường HTTP riêng chỉ cho care. Nhưng ban đầu chỉ quảng bá GenBot cho tác vụ chữ đã được chứng nhận. noTools=true không gây lỗi cho lean vốn chạy tools=none; điều nguy hiểm là diễn giải nhầm nó thành “runtime không hỗ trợ MCP” rồi thay policy chung.

**Trần thật:** ngân sách lean có persona 6.000 + skill 12.000 + memory 1.500 + brain 4.000 = 23.500 ký tự trước task, moduleContext và định dạng. Cap care 12.000 không bảo đảm tổng ≤20.000. ModuleContext còn bị cắt chuỗi ở core; JSON bị cắt có thể mất nghĩa trước khi chạm Bot API.

**Chứng cứ nền:** src/runtimes/contracts.ts:29–30; src/shared/contracts.ts:134–136; src/shared/context.ts:126–150, :178–181, :203; src/work/engine.ts:214–234.

| Caller §8 đã đọc | Hậu quả thực tế với GenBot |
|---|---|
| modules/_template/server/index.ts:19–32 | Chỉ chữ; không hỏng vì thiếu tools/ảnh. Prompt tự do chưa giới hạn, vẫn có thể vượt tổng cap. |
| modules/ads/server/analyst.ts:19–23 | Phân tích dữ liệu đưa sẵn nên không cần tools. JSON account/KPI/queue và ngữ cảnh core cần ngân sách; cắt moduleContext thô làm mất dữ liệu. |
| modules/care/server/application/agent-runner-lean.ts:25–33 | Chuyển cả images/documents. Module đã đọc capabilities tại module-runtime.ts:142–148, nhưng tin chỉ có ảnh/PDF sẽ mất chứng cứ khi chuyển sang GenBot; cần chuyển chủ/fallback rõ ràng. |
| modules/kol/server/agent-turn.ts:35–58 | Chỉ chữ trong wrapper; input.system + prompt chưa có cap. Nhánh @chatgpt chủ động chọn Codex, không tự chuyển mọi lượt theo agent mặc định. |
| modules/marketing/server/agent-run.ts:22–29 | Chỉ chữ, prompt tự do. Classifier batch 40 bài, mỗi text tới 280 ký tự cộng JSON/system/core đã đủ làm nguy cơ vượt cap thực tế: analytics/analyst.ts:28, :291–299. |
| modules/radar/server/agent-turn.ts:29–34 | Gộp system vào prompt; nội dung thu thập không có trần toàn request tại wrapper. Phân tích dữ liệu sẵn có dùng được nếu chia lô. |
| modules/radar/server/collectors/x-grok.ts:33–53, :169–179 | Yêu cầu tìm X thật; GenBot không có search, JSON URL trông hợp lệ không chứng minh đã thu thập. Lưu ý lỗi có sẵn: Grok lean cũng tắt web search tại src/runtimes/grok.ts:90–119. Giữ tên runtime Grok chưa tự sửa được lỗi. |
| modules/video/server/edit/agent/director.ts:589–660 | Gửi frame/asset images và ngữ cảnh dự án dài; images=false mất cơ sở quyết định hình ảnh. Phải giữ runtime vision hoặc chặn tính năng, không âm thầm bỏ ảnh. |
| modules/video/server/edit/assets/hub.ts:52–62 | Wrapper nhận ảnh; score.ts:53–75 đã kiểm seesImages và có fallback chấm bằng chữ. Không được báo toàn bộ caller này chắc chắn hỏng; chất lượng đánh giá hình ảnh giảm. |
| modules/video/server/kol-port.ts:128–137 | Wrapper chữ, system+prompt chưa giới hạn; cần budget, không cần MCP ở chính call này. |
| modules/zalo/server/index.ts:121–127 | Dùng cho biến thể mẫu marketing, không phải trả lời care; variants.ts:110–123. Khi tắt marketing thì không thuộc đường inbox cần port. |
| src/modules/compat/agent-engine.ts:81–104 | Chuyển images và prompt tự do, không tự kiểm capability; các consumer vision qua bridge phải bị chặn/fallback. |

**Sửa:** ngân sách tổng request tại context builder, dành chỗ cho chỉ dẫn/schema/tin mới, chia lô theo caller; adapter vẫn từ chối quá cỡ như lớp bảo vệ cuối. Tách khả năng nhận MCP khỏi noTools. Với lượt thường, GenBot không đọc được đường dẫn skill mà context hiện chỉ đưa tên/path; inline skill được cấp hoặc từ chối tác vụ cần đọc file. doctor phải tách kiểm runtime chung và kiểm cấu hình agent, không thể dùng hợp đồng hiện tại để làm điều kế hoạch nói.

### 7. Cao — Bảng HTTP → ErrorFamily không tạo được cơ chế chờ/phục hồi

**Sai:** engine coi mọi RunResult lỗi là kết thúc task; không tự retry transient hay dùng retryAfter. runLean còn bỏ mất family và retryAfter khỏi kết quả trả module. Chỉ auth/quota/config có attention, nên needs_approval→access sẽ kết thúc thất bại mà không nổi đúng yêu cầu chủ xử lý.

**Chứng cứ:** src/work/engine.ts:22, :50–64, :248–254; src/modules/context.ts:61–81; GenBot/desktop/server/bot-api-host.ts:129–137, :227–257.

| Nhánh | Kết luận và sửa |
|---|---|
| 400/413/415 → config; 401 → auth | Hợp lý. Quá cap do thiết kế prompt phải sửa ở builder, không bắt chủ tự sửa YAML mỗi lượt. |
| 403 → config | Chấp nhận được, nhưng nguyên nhân còn có bot không tồn tại và Cloud Starter; hiển thị đúng nguyên nhân đã làm sạch. |
| 404 → transient | Sai cho thread không tồn tại; poll tiếp cùng thread không chữa được. Dùng config hoặc lỗi session không còn hợp lệ, dừng phục hồi mù. |
| 409 → transient | Phân loại hợp lý nếu có scheduler backoff thật; hiện chỉ làm task failed. Phân biệt thread đang chạy với cap, giữ thread đã biết. |
| 429 → quota | Đúng họ, nhưng retryAfter không có consumer; mỗi task có thể sinh attention riêng. Cần hàng đợi theo bot và một thông báo gộp, không retry POST mù. |
| 202 needs_approval → access | Không đủ: lưu thread, trạng thái chờ và attention có đường mở GenBot. Chọn access mà không sửa lifecycle sẽ mất luồng chờ. |
| 502 → unknown | Hợp lý vì API cố ý giấu nguyên nhân; không suy ra lỗi này luôn retry được. |
| Network → transient; abort → cancelled | Đúng nhãn nhưng kết quả POST có thể không biết. Huỷ fetch không phải huỷ turn GenBot; API công khai không có cancel/idempotency. Không phát lại thành thread mới tự động. |

GET chỉ nhìn busy/pendingCard rồi ghép replyText, không trả terminal outcome bền vững. Turn lỗi sau lần POST 202 có thể được GET coi là reply rỗng/không đầy đủ; adapter không được coi mọi 200 là một câu trả lời nghiệp vụ hợp lệ. Với care phải kiểm JSON; muốn bảo đảm lỗi cuối cho mọi caller cần bổ sung outcome phía giao thức.

Mỗi lượt một thread **dùng được cho MVP stateless**; thread xong không chiếm cap 50. Giới hạn được thực thi theo botId; limiter theo tên key_env bị vượt khi hai biến trỏ cùng bot, và limiter bộ nhớ không phối hợp nhiều process. Dùng endpoint+botId làm khoá, cap đồng thời và tổng lượt dùng chung; max_runs_day theo agent không thay trần theo bot. wait=120 được schema cho phép nhưng tài liệu cảnh báo proxy 60 giây: bắt đầu ≤50 giây rồi poll; một deadline phải bao gồm xếp hàng, POST và poll. Nối session sau này không chữa rate limit, còn thay đổi mô hình trí nhớ/quyền.

**Chứng cứ bổ sung:** GenBot/desktop/docs/bot-api.md:39–60; GenBot/desktop/server/bot-api-host.ts:111–124, :149, :169, :250–257; src/modules/context.ts:50–51.

### 8. Cao — Hard handoff đặt sai điểm và có thể gửi lại câu cũ sau khi hết pause

**Sai:** eligibility là hàm quyết định, không phải nơi ghi DB/raise attention; ingest hiện không gọi nó trước enqueue. Chỉ đặt paused_until không đủ: code đòi isPaused=true. Chặn job mới cũng không chặn reply đang chạy hoặc intent cũ.

**Kịch bản:** model đang trả lời thì khách nói “gặp nhân viên”. Rule mới bỏ một job, nhưng reply cũ vẫn tạo intent. Nếu chỉ pause auto, send guard defer rồi hết 60 phút gửi câu trả lời đã lỗi thời. Approved draft không chịu cùng nhánh pause auto; phải quyết định rõ duyệt trước handoff có còn hiệu lực không.

**Chứng cứ:** modules/care/server/application/ingest.ts:445–498; modules/care/server/policy/eligibility.ts:255–270; modules/care/server/application/agent-turn.ts:309–315, :401–422; modules/care/server/runtime/care-guard.ts:62–85.

**Sửa:** khi ingest tin live inbound đã chuẩn hoá và đúng người/đúng hội thoại, ghi handoff state nguyên tử trước enqueue, đồng thời đặt is_paused và paused_until. Giữ eligibility thuần để đọc trạng thái ở pre-run, post-run và send. Hủy/chuyển review intent tự động cũ bằng phiên bản trạng thái, không chỉ defer; chỉ chủ mới giải quyết chuyển giao. Takeover/off đã có, tận dụng thay vì dựng hệ trạng thái thứ ba.

### 9. Cao — Mắt xích công thức → bài → số liệu đang đứt ở nhiều nơi

**Sai:** §5.7.7 đưa meta.cong_thuc và meta.hoc_tu vào fb_content chưa có meta; §5.6.1 nghe sự kiện chưa có; status enum không phải event. Chỉ thêm một emit snapshot không vá được cả chuỗi.

**Kịch bản cụ thể:** chủ chọn ý tưởng; writer loại meta nên bài mất nguồn ngay khi insert. Kể cả thêm cột, publisher đăng xong và analytics import cùng bài trước khi publisher lưu fb_post_id: publisher bắt lỗi unique rồi lưu dòng gốc với fb_post_id=null. Metrics nối theo native post ID sẽ thuộc dòng imported không mang công thức. Bot Đối chiếu không thấy bài có nguồn, hoặc đếm thành hai bài.

**Chứng cứ:** modules/marketing/server/store.ts:193–215, :830–855, :892–895; modules/marketing/server/core/publisher.ts:252–273; modules/marketing/server/store.ts:877–888.

**Sửa:** đưa vào trước P6 một hợp đồng nguồn gốc bền vững: idea ID, source video ID, formula ID+version, content ID nội bộ, target/platform account và native post ID. Cập nhật migration/type/DTO/writer/clone/approval/publisher/import reconciliation cùng nhau; không chỉ nhét meta vào nơi tạo. Emit event sau giao dịch, dùng tên đầy đủ marketing:metrics.snapshot, consumer có cursor/idempotency và quét bù khi khởi động. SDK tự prefix event không có dấu hai chấm: learn.on('metrics.snapshot') sẽ nghe learn:metrics.snapshot, không nghe marketing:metrics.snapshot (src/modules/context.ts:37, :165–170).

### 10. Cao — Vòng “học” có thể xác nhận công thức bằng số liệu không so sánh được

**Sai:** note chỉ có một er/reach và danh sách moc_da_do, nên lần 7 ngày ghi đè giá trị 24 giờ. So bài mới 24 giờ với các bài cũ đang mang mốc 7/28 ngày gây lệch. Bài đang đánh giá có thể lọt chính vào median dùng làm kỳ vọng; kỳ vọng thay đổi theo kết quả thay vì được cố định lúc tạo thử nghiệm.

**Kịch bản:** công thức có ba bài, bài thứ ba kéo median của chính công thức xuống rồi được đánh giá “đạt kỳ vọng”; cùng bài đổi nhãn sau lần đo 7 ngày dù không đổi công thức. YouTube chỉ có views/likes/comments, reach=null; dùng chung ER theo reach có thể tạo null, chia cho 0 hoặc thay thế bằng số bịa. Mốc 1 giờ còn có thể không tồn tại nếu app tắt lâu; sync hiện bỏ mốc quá trễ.

**Chứng cứ:** docs/dev/OPEN-AGENTICOS-PLAN.md:178–195, :769–774; modules/marketing/server/analytics/metrics.ts:106–110, :495–508; modules/marketing/server/analytics/sync.ts:419; modules/kol/server/metrics.ts:117–129.

**Sửa:** lưu mỗi snapshot cùng platform/account/format/milestone và thời điểm đo; note là bản trình bày, không gom mất lịch sử. Cố định baseline, formula version và kỳ vọng trước thử; loại bài đang chấm khỏi baseline. Tách thước đo từng nền tảng, giữ unknown, yêu cầu coverage. Ngưỡng 3/4 bài chỉ đủ nhãn thăm dò, không chứng minh công thức gây tăng hiệu quả. Tận dụng phép tính hiện có thay vì tự tính từ frontmatter thiếu dữ liệu.

### 11. Cao — Tách social-stats chưa đủ để bỏ KOL, và P6 không chỉ cần dung_boi

**Sai:** KOL reader dựa vào account, target đã publish và external ID của KOL. Tách hàm Composio không tạo hệ nhập video tài khoản, mapping target hay publisher Instagram/TikTok/YouTube. P9 lại coi KOL/video là tuỳ chọn trong khi màn soạn đa nền tảng không có phase triển khai rõ.

**Kịch bản:** cài bản gọn không KOL: social không có published targets để đo, learn không biết content nào thuộc công thức; đường video gọi port KOL cho generate/post cũng mất dịch vụ. Bài học có dung_boi nhưng agent không có scope learn sẽ không nhận agentContext.

**Chứng cứ:** modules/kol/server/metrics.ts:193–198; modules/video/server/kol-port.ts:46–65, :88–115; src/work/engine.ts:82–89.

**Sửa:** chọn Facebook-only cho v1; hoặc đưa việc tách account/OAuth/publisher/target ID và import/reconcile vào dependency trước P5–P6. Với learn phải cấp scope rõ, lọc bài học theo công ty/quyền, budget context và kiểm version bài học thực sự đã đưa vào run; chỉ dung_boi không đủ chứng minh vòng áp dụng.

### 12. Cao — Trần Apify hậu kiểm không phải rào chi tiền

**Sai:** §5.7.9 lấy số kết quả trả về suy ra chi phí rồi dừng khi chạm trần. Collector khởi chạy actor trước, chỉ đọc usageTotalUsd sau khi xong; thiếu chi phí còn mặc định 0. limit dataset không phải giới hạn chi phí actor. Hết thời gian poll không abort actor.

**Kịch bản:** một actor vượt ngân sách ngày trước khi trả kết quả; app tắt hoặc timeout, run vẫn chạy tính phí nhưng dream_runs không ghi được chi phí. Hai lịch chạy hoặc Radar và Dream dùng chung tài khoản cùng nhìn “còn tiền” rồi đều khởi động.

**Chứng cứ:** modules/radar/server/collectors/apify.ts:179–209; docs/dev/OPEN-AGENTICOS-PLAN.md:693–696, :778–780.

**Sửa:** chủ đặt ngân sách rõ; giữ chỗ ngân sách nguyên tử trước launch, giới hạn chi phí upstream nếu actor hỗ trợ, lưu run ID ngay, đối soát chạy dở và chi phí unknown; dùng chung ledger giữa Radar/Dream. dream_runs cần khoá lượt theo ngày/timezone và trạng thái retry. Không dùng con số 2–6 USD/1.000 kết quả trong lời mô tả integration làm báo giá đã kiểm chứng.

### 13. Trung bình — Mở media care và tắt marketing chưa được tính đủ phạm vi

**Sai:** sendMedia:[] không chỉ là cờ UI. Đường care transport hiện chỉ gọi sendMessage với text; outbox input không có hợp đồng media. Sender Zalo cũ gửi được attachment là đúng, nhưng không tự có semantics giao nhận/dedupe của care.

**Kịch bản:** bật cờ capability nhưng payload không mang media; hoặc gửi album thành công một phần, retry gửi trùng. Tắt marketing ở module.json cũng chưa đổi daemon mặc định bật; daemon bắt đầu bằng biến môi trường riêng trước khi core đẩy config.

**Chứng cứ:** modules/care/server/application/outbox-service.ts:46–68; modules/zalo/server/connectors/zalo/zca-transport.ts:182–194, :230–249; modules/zalo/server/sender.ts:333–379; modules/zalo/server/daemon.ts:87, :121–134.

**Sửa:** hoặc hoãn manual media khỏi lát cắt đầu, hoặc làm trọn upload/validation/payload revision/hash/receipt/retry cho từng attachment qua connector. Tắt marketing tại mọi default/bootstrap, kiểm hàng chờ có sẵn khi chuyển chế độ. Giữ mã vận chuyển AGPL trong module Zalo, không chép sender sang care.

### 14. Trung bình — P0 NotesService chưa đáp ứng chính các consumer được hứa

**Sai:** patch chỉ sửa frontmatter và giữ thân, nhưng editor và Bot Đối chiếu cần sửa thân. actor='owner'/'system' là string do caller đưa, không phải bằng chứng quyền. Reindex folder sau mỗi patch cộng watcher và một commit mỗi snapshot sẽ khuếch đại I/O.

**Kịch bản:** compare muốn thêm hai câu ở thân không có API phù hợp, module lại tự fs.writeFile phá hợp đồng; caller truyền actor='system' bỏ qua glob. Mỗi batch metrics sửa nhiều note gây nhiều lần quét folder/commit; commit lỗi sau ghi file không có quy định phục hồi.

**Chứng cứ:** docs/dev/OPEN-AGENTICOS-PLAN.md:251–271, :774; src/shared/brain.ts:213–240; src/access/policy.ts:99–107, :126–127.

**Sửa:** thu nhỏ P0 thành read + typed frontmatter/body operations với principal lấy từ context tin cậy, optimistic concurrency bắt buộc khi sửa bản đã đọc, path canonical/symlink guard, atomic write. Tách indexing/event/git hậu xử lý, gộp batch và chỉ stage file thuộc thao tác. Hoãn graph/backlinks và git-per-write. Không gọi SQLite “chỉ mục dựng lại được” khi orders/scores/workflow chỉ lưu ở DB và chưa có định dạng phục hồi.

### 15. Trung bình — Dream 100 lấy mẫu và phân tích không đủ cho kết luận đề xuất

**Sai:** lấy 10 video mới nhất mỗi ngày nhưng baseline dùng 30 video; video ra khỏi top 10 không còn được cập nhật. Quét 3 video để giảm giá còn làm sai lệch thêm. Schema không lưu lần lỗi liên tiếp để thực thi “3 ngày lỗi”; không có ràng buộc duy nhất day cho run. Bốn frame trong ba giây đầu không mô tả toàn bộ cấu trúc video.

**Kịch bản:** kênh đăng nhanh, video cũ đóng băng ở số xem lúc mới đăng, trung vị thấp giả tạo; video bình thường bị chọn là outlier 3×. GenBot không thấy frame, video không có auto-sub thì hầu như không có chứng cứ để gắn nhãn cấu trúc. Thiếu ffmpeg/ffprobe cũng làm phân tích hỏng dù đã xử lý thiếu yt-dlp.

**Chứng cứ:** docs/dev/OPEN-AGENTICOS-PLAN.md:679–696, :727–748, :780; modules/radar/server/collectors/sources.ts:481–496; modules/video/skills/video-learn/SKILL.md:50–58.

**Sửa:** v1 nhận URL tham khảo thủ công/RSS và tạo đề xuất để chủ xem. Nếu làm tự động, bootstrap lịch sử, refresh cùng tuổi video, lưu age/captured_at/nguồn, loại baseline không đủ coverage; phân tích toàn clip bằng bằng chứng đủ và báo thiếu dữ liệu. Tách collectors cần port cả phụ thuộc context/types/kv/browser, không chỉ di chuyển bốn file (modules/radar/server/collectors/sources.ts:3–9).

### 16. Trung bình — Kế hoạch giấy phép vừa suy diễn quá mức, vừa thiếu việc phát hành cụ thể

**Sai:** suy từ “port qua repo private” thành “đều chịu giấy phép upstream thương mại” trái hồ sơ hiện có; ngược lại, bấm đồng ý AGPL/cài riêng không tự chứng minh ranh giới pháp lý. Hash không chứng minh bản quyền sạch.

**Kịch bản:** chép helper sender AGPL vào core MIT khi làm media; hoặc phát hành module modified qua mạng mà chỉ có hộp thoại đồng ý, không có nguồn tương ứng. Chạy provenance qua rồi công bố toàn bộ là mã tự viết cũng không có cơ sở: công cụ chỉ tìm cửa sổ tám dòng đã chuẩn hoá, có exclusions và snapshot upstream.

**Chứng cứ:** LICENSE:25–27; modules/zalo/NOTICE:3–15; modules/zalo/LICENSE:540–550; THIRD_PARTY_NOTICES.md:62–72; scripts/check-provenance.mjs:14–36; scripts/provenance/upstream-index.txt:1. NOTICE còn liệt kê Paperclip, OpenFilm, FireRed, open-edit, video-use (THIRD_PARTY_NOTICES.md:9–17), không được làm mất khi đóng gói.

**Sửa:** trước quyết định sao chép/tách code, lập danh mục nguồn và ranh giới module đúng hồ sơ; trước phát hành, xác nhận quyền từ người có thẩm quyền và cách cung cấp corresponding source/notice. Dùng AGPL-3.0-only. Đây là kiểm tra tính nhất quán của hồ sơ repo, không phải kết luận pháp lý về tác phẩm kết hợp hay xác nhận quyền tác giả độc lập.

## Mục CẦN KIỂM

1. **§5.1.3 — GET Bot API: đã giải quyết.** GET trả 200 {reply, thread} hoặc 202 {thread, status}; needs_approval có thể tiếp tục GET sau khi chủ xử lý trong app. Không đi qua manager.admit nên poll GET không tiêu quota POST. GET 404 là thread không tồn tại/không phải API thread. Chứng cứ: GenBot/desktop/docs/bot-api.md:49–60; GenBot/desktop/server/bot-api-host.ts:227–257. Hạn chế terminal outcome xem phát hiện 7.

2. **§5.2.2 — API đặt is_paused/paused_until: chưa có đường API đó trong code đã rà.** Đã có workflow snooze, AI off/draft/auto và takeover; chúng không tương đương timed pause trên care_conversations. Snooze đổi care_conversation_state, không đặt hai cột này. Chứng cứ: modules/care/server/api/routes-workflow.ts:63–90; modules/care/server/workflow/index.ts:112–160; modules/care/server/policy/eligibility.ts:258–260. Tận dụng takeover/off; thêm hợp đồng timed pause nếu còn cần.

3. **§5.2.4 — Trường kết bạn zca-js 2.1.2: vẫn chưa xác minh được.** package-lock.json:8927–8931 xác nhận phiên bản 2.1.2, nhưng workspace không có source package node_modules/zca-js để đọc; không được install/network theo nhiệm vụ. Không đoán field. Đường profile hiện chỉ ánh xạ tên/avatar và API cũng giới hạn DTO, nên chỉ sửa care-profiles.ts chưa đủ: modules/zalo/server/care-profiles.ts:32–38; modules/care/server/api/routes-profiles.ts:21–24.

4. **§5.3.2 — care provides: đã giải quyết.** Chỉ cung cấp careChannels, chưa có customers service (modules/care/server/index.ts:30–34). CRUD nội bộ đã có create/get/update CAS/list, không viết lại: persistence/directory-stores.ts:21–116. Phải expose create cho import note mới, pagination thay list cap 500 và phát change event cho mọi đường thay đổi; revision profile/task không nằm trong revision customer.

5. **§5.6.1 — Event metrics: đã giải quyết.** Chưa emit ở đường lưu snapshot; worker chỉ điều phối, sync gọi upsertFbPostMetrics. Chứng cứ: modules/marketing/server/analytics/worker.ts:82–105; analytics/sync.ts:454; store.ts:877–888. Cũng chưa có event published ở publisher.ts thực tế là modules/marketing/server/core/publisher.ts:252–273. Cần đầy đủ tên namespace và cơ chế đọc bù, không chỉ thêm emit.

6. **§5.6.5 — payload_revision/approved_revision: đã giải quyết.** Tạo intent ở revision 1; nhánh pending có thể đã approved ngay. Sửa nháp tăng payload_revision, xoá approval; duyệt gán approved_revision bằng revision hiện tại. Vì vậy equality hai revision chỉ chứng minh đã duyệt đúng bản hiện tại, không chứng minh “gửi nguyên”. Chứng cứ: modules/care/server/persistence/outbox-store.ts:448–466, :517–519, :575–576. Đếm nháp AI có source run, provenance lúc tạo, payload không đổi so bản gốc và thực sự sent; loại manual/auto khỏi mẫu “chủ duyệt nháp”, nêu rõ mẫu số gồm nháp sửa/bỏ. Revision=1 là chỉ dấu bảo thủ; so hash gốc mới phân biệt sửa rồi hoàn tác.

**Giới hạn khác:** Không xác minh được giấy phép hiện tại của blogminhquy/javis-os, public Freedombuiders/freedom_os, hay việc WHO 10X không có giấy phép từ các file LICENSE/NOTICE trong hai repo được phép đọc; không dùng mạng để bù. GenBot/desktop/LICENSE:2–6 xác nhận Apache-2.0 cho phần đó, không xác nhận tuyên bố “nguồn giữ kín” của một kế hoạch nội bộ không được cung cấp. Không xác minh ý định chủ trong §1, 36 khung UI ngoài repo, danh tính “treg”, giá nhà cung cấp, hay độ trễ/chi phí dịch vụ thật. Không chạy provenance/tests nên không báo chúng pass; kết quả ở đây là kiểm tra tĩnh, không phải nghiệm thu runtime.

## Nên cắt, nên đổi thứ tự

- **Trước P1:** sửa hợp đồng capability/doctor, cách giữ secret, tổng budget prompt, owner approval và trạng thái remote turn. Phân định license trước khi di chuyển code xuyên module; đóng gói nguồn tương ứng là điều kiện trước phát hành.
- **Lát cắt đầu:** GenBot chữ → care nháp → chủ duyệt → gửi một lần, pause/takeover đúng và tắt marketing ở mọi default. Không cần đợi graph, git-per-write hay CRM hai chiều mới kiểm được giá trị sản phẩm.
- **CRM đầu tiên:** SQLite → note một chiều; hoãn import, ranking bốn trọng số, chân dung nhóm A và hệ đơn hàng mới. P0 chỉ cần writer an toàn phục vụ export.
- **Marketing tiếp theo:** Facebook có duyệt, lưu lineage từ ý tưởng đến native post ID trước; rồi snapshot theo mốc và note đối chiếu. Tận dụng classifier/analytics đã có. P7 hiện phụ thuộc một thay đổi schema/publisher ở P6 chưa được lập việc.
- **Hoãn khỏi v1:** Meta write, voice, graph, Dream 100 quét/tải/phân tích hằng ngày, tách đa nền tảng đầy đủ. Nếu vẫn hứa đa nền tảng, account/publisher/target mapping phải tách trước khi bỏ KOL ở P9.
- **Không để P9 mới phát hiện packaging dependency:** bản gọn cần luồng cài Zalo thực sự hoạt động; chuyển code AGPL, phụ thuộc private và quyền nguồn là đầu vào cho lựa chọn kiến trúc, không phải việc đổi tên cuối dự án.

## Những gì đúng

- Runtime là điểm nối hợp lý; runLean đã tạo task qua engine và không có core conversation để tự giữ session: src/modules/context.ts:39–49. GenBot mới mỗi lượt là MVP khả thi nếu xử lý quota/lifecycle và memory riêng.
- Bot API thực sự bị confined, không shell/MCP/apps; trần message 20.000, body 256 KB, mốc 10 POST/phút và pending 50 có trong tài liệu/host: GenBot/desktop/docs/bot-api.md:39–80; GenBot/desktop/server/bot-api-host.ts:250–257. Không báo usage bằng 0 là đúng contracts: src/runtimes/contracts.ts:71–72.
- Care đã có JSON reply strict, draft/outbox, gate và kiểm lại sau model; nên sửa trên đường này, không tạo sender mới: modules/care/server/application/agent-output.ts:7–9; agent-turn.ts:401–422; persistence/outbox-store.ts:448–466.
- Thiếu PUT brain/file là lỗi có thật: src/api/routes/brain.ts:53–62 chỉ GET, web/src/components/BrainNoteEditor.tsx:72 gọi PUT. Nền write API có giá trị độc lập với sync hai chiều.
- Không suy doanh thu từ stage=won là đúng; care_customers chỉ có stage, không có đơn/giá trị mua: modules/care/server/persistence/schema.ts:296–307.
- Lõi có LICENSE MIT; Zalo có ngoại lệ AGPL cho toàn module và NOTICE liệt kê 12 file nguồn; GenBot desktop có Apache-2.0: LICENSE:1–27; modules/zalo/NOTICE:3–31; GenBot/desktop/LICENSE:2–6.
