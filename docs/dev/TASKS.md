# AIOS-Lite — Danh sách task

> Chi tiết của [BUILD-PLAN.md](BUILD-PLAN.md).
> - **Phần 1:** 20 task, mỗi task 2–3 ngày công. Dùng để ước lượng và theo dõi.
> - **Phần 2:** 132 việc con (cột "Gồm" ở Phần 1 trỏ tới đây), làm checklist khi code.

## Phần 1 · 20 task (2–3 ngày mỗi task)

| # | Task | Gồm | Ngày | Phụ thuộc | Xong khi |
|---|---|---|---|---|---|
| T01 | **Khung dự án và hợp đồng:** đổi stack Preact, DB và migration lõi, bus, mã hoá, hợp đồng giữa các tầng, API.md | P0-01…09 | 2 | — | typecheck và build qua trên khung rỗng; API.md đủ endpoint |
| T02 | **Công cụ port:** quét symbol compat, script copy, tách SQL, script kiểm nguồn gốc, manifest 5 module, brief | P0-10…15 | 2 | T01 | mọi file nguồn đã được xếp loại; script chặn copy nhầm hoạt động |
| T03 | **Runtime 1:** bộ chạy tiến trình con, parser, mock, adapter Claude và Codex | A-01…05 | 3 | T01 | test xanh với CLI giả |
| T04 | **Runtime 2:** Grok, ACP + Hermes, doctor, **kiểm thật 4 CLI** và các cờ chặn quyền | A-06…10 | 3 | T03 | 4 CLI trả lời thật; bảng chặn quyền đã được kiểm chứng |
| T05 | **Agent và tầng dùng chung:** schema và registry agent, Second Brain nhiều thư mục, bộ nhớ, skill, bảng đội, dữ liệu mẫu | B-01…06, B-11 | 3 | T01 | gõ không dấu vẫn tìm được; 5 agent mẫu được nạp |
| T06 | **Phân quyền và ngữ cảnh:** kết nối (MCP, env, Composio), `resolveAccess`, nhật ký, context `standard` / `lean` | B-07…10 | 2 | T05 | test: agent không được cấp thư mục B thì không thấy B |
| T07 | **Giao việc 1:** task, run, bình luận, Cần bạn, chỉ thị, dispatcher, engine | C-01…06 | 3 | T03, T06 | việc chạy qua engine với `mock`; không nhận trùng việc |
| T08 | **Giao việc 2:** hỏi cả nhóm và relay, lịch, chat, khôi phục khi khởi động lại, `main.ts` | C-07…10 | 2 | T07 | luồng giao việc → chờ → tổng hợp chạy hết |
| T09 | **Module runtime:** loader, Add / Remove / Purge, Module SDK, `runLean`, lớp compat, CLI, `_template` | D-01…04, D-10 | 3 | T02, T07 | `_template` Add / Remove được, không khởi động lại |
| T10 | **API:** server, SSE, 3 nhóm route, test hợp đồng | D-05…09 | 2 | T07, T09 | test hợp đồng khớp API.md |
| T11 | **Web 1:** viết lại các component nền, copy component dùng chung, khung app, nạp module, trang Tổng quan và Agents (tab Quyền) | E-01…06 | 3 | T01 | các trang hiện được với API giả |
| T12 | **Web 2 và cổng P1:** Công việc, Chi tiết việc, Lịch, Chat, Second Brain, Bộ nhớ, Skills, Kết nối, Nhật ký, Module, Cài đặt; build; **kiểm toàn bộ lõi** | E-07…11, G1-01…05 | 3 | T10, T11 | lõi chạy thật đầu cuối, kể cả 4 CLI và phân quyền |
| T13 | **Module care 1:** copy, xoá phần bỏ, nối lại backend, lượt agent `lean`, kênh mở rộng, khai báo module | CARE-01…06 | 3 | T12 | typecheck qua; fake connector chạy |
| T14 | **Module care 2:** giao diện, agent mẫu và skill, sửa test copy, e2e 4 kịch bản | CARE-07…11 | 3 | T13 | tin đến → nháp → duyệt → gửi; tự động có Huỷ; giờ nghỉ; tiếp quản |
| T15 | **Module zalo:** copy, daemon theo Add / Remove, nối vào care, marketing Zalo, giao diện, AGPL | ZALO-01…10 | 3 | T13 | test xanh; tạo được mã QR thật; tin giả vào hộp thư care |
| T16 | **Module marketing:** Facebook Content Studio (đăng bài, bình luận AI, phân tích) | MKT-01…09 | 3 | T12 | test xanh với Composio giả |
| T17 | **Module gmail và ads:** đồng bộ Gmail vào care; Ads chỉ đọc với quy tắc R1–R5 | GMAIL-01…05, ADS-01…06 | 3 | T13, T16 | test xanh; Ads không có lệnh ghi nào sang Meta |
| T18 | **Ghép và cổng P2:** Add cả 5 module, e2e Playwright, Remove / Purge, chụp màn hình | G2-01…04, P3-01…02 | 2 | T14…T17 | e2e xanh |
| T19 | **Thử thật và phát hành:** Facebook, Gmail, Meta Ads, Zalo (**hỏi bạn từng mục**); NOTICE, LICENSE, README | P3-03…07 | 2 | T18 | 4 mục thử thật đạt hoặc ghi rõ lý do chưa đạt |
| T20 | **Tài liệu dạy học:** 8 bài | P3-08…15 | 3 | T18 | 8 bài trong `docs/lessons/` |

**Ước lượng:**
- **Tổng khoảng 53 ngày công** nếu một người làm tuần tự.
- **Đường găng khoảng 29 ngày** nếu chạy song song tối đa: T01 → T05 → T06 → T07 → T09 → T10 → T12 → T13 → T14 → T18 → T20. T19 chạy song song với T20.
- **Lõi xong vào khoảng ngày 18; module xong vào khoảng ngày 24.**
- Khi code bằng 5 agent chạy song song thì thời gian thực ngắn hơn nhiều. Những phần **không rút ngắn được** là kiểm thật, chờ bạn duyệt, và quét QR / kết nối tài khoản thật.

---

## Phần 2 · Việc con (checklist khi code)

> Mỗi việc con cỡ 1–3 giờ làm của một agent và có tiêu chí "Xong khi" để kiểm.
> **GỐC** = `~/Developer/GitHub/claudeclaw-os`.
> Loại copy A/B/C/D/E/F: xem BUILD-PLAN §0.

**Chủ sở hữu:**
- **Mình**: coordinator.
- **A–E**: 5 agent Sonnet ở giai đoạn P1.
- **CARE / ZALO / GMAIL / MKT / ADS**: 5 agent Sonnet ở giai đoạn P2.

Đánh dấu `[x]` khi xong. Task nào cần quyền hoặc hành động thật thì có ghi chú **(hỏi bạn)**.

---

## P0 · Nền (Mình, làm tuần tự)

| | ID | Việc | Kết quả | Phụ thuộc | Xong khi |
|---|---|---|---|---|---|
| [x] | P0-01 | Gỡ React. Cài preact, wouter-preact, lucide-preact, tailwindcss 4, @tailwindcss/vite, @preact/preset-vite. Hạ TS 5.9, Vite 6, Vitest 3. Thêm pino 9, zca-js 2.1.2, @composio/core 0.22, image-size 2.0.2, cron-parser 5 | `package.json` | — | `npm ls` không báo lỗi peer |
| [x] | P0-02 | Cấu hình web: Vite (alias `@`, preset Preact, Tailwind, proxy `/api`), `web/tsconfig.json`, `index.html`, `main.tsx` rỗng | `vite.config.ts`, `web/*` | P0-01 | `vite build` qua |
| [x] | P0-03 | Cấu hình server: tsconfig, Vitest chạy 2 dự án (server ở node, web ở jsdom) | `tsconfig.json`, `vitest.config.ts` | P0-01 | `npm test` chạy, 0 test |
| [x] | P0-04 | `core/config.ts` + `core/env.ts` (đọc `.env`, `setEnvKey`) | 2 file + test | P0-03 | test xanh |
| [x] | P0-05 | `core/db.ts`: mở DB (WAL), bộ chạy migration, kiểm tra module chỉ tạo bảng đã khai báo. Migration `001_core.sql` với **mọi bảng lõi** | file + test | P0-04 | chạy migration 2 lần không lỗi |
| [x] | P0-06 | `core/events.ts` (bus có kiểu), `redact.ts`, `crypto.ts` (AES-GCM), `log.ts` (pino) | 4 file + test | P0-04 | test xanh |
| [x] | P0-07 | Hợp đồng: `runtimes/contracts.ts`, `access/contracts.ts`, `shared/contracts.ts`, `work/contracts.ts` | chỉ kiểu và chữ ký | P0-05 | typecheck qua |
| [x] | P0-08 | Hợp đồng: `modules/sdk.ts` (kiểu `defineModule`, `ModuleContext`), `web/src/module-host/contracts.ts` (`defineWebModule`, provides, widgets) | chỉ kiểu | P0-07 | typecheck qua |
| [x] | P0-09 | `docs/dev/API.md`: mọi endpoint, mẫu request/response JSON, sự kiện SSE | tài liệu | P0-07 | đủ nhóm endpoint ở ARCHITECTURE §10 |
| [x] | P0-10 | Quét symbol loại C mà code sẽ copy đang gọi (ví dụ `logger.*`, `sanitizeOutboundText`, `isKillSwitchOn`, hàm `db`…) | `docs/dev/port/compat-symbols.md` + stub `src/modules/compat/index.ts` | P0-08 | mỗi symbol có chữ ký và chỗ thay thế |
| [x] | P0-11 | `scripts/port/copy.mjs`: copy theo manifest, **từ chối file có ở upstream**, ghi `PORTING.md` | script | P0-03 | thử copy `src/email` ra đúng file |
| [x] | P0-12 | `scripts/port/extract-db-sections.mjs`: tách các đoạn `@…-schema/db/migrations` trong `db.ts` thành `migrations/*.sql` và `store.ts` | script | P0-11 | thử với `@email-*` ra đủ bảng và hàm |
| [x] | P0-13 | `scripts/check-provenance.mjs`: báo lỗi khi có ≥ 8 dòng liên tiếp trùng upstream, hoặc chữ "ZaloCRM" ngoài `modules/zalo`. Gắn vào `npm test` | script | P0-03 | cố tình thêm một đoạn upstream thì script báo lỗi |
| [x] | P0-14 | Sinh manifest giữ / chuyển / bỏ đến từng file, rồi duyệt tay | `docs/dev/port/{care,zalo,gmail,marketing,ads,core-web}.md` | P0-11 | mọi file trong phạm vi đều đã được xếp loại |
| [x] | P0-15 | Brief cho agent: quy tắc, sở hữu file, cách báo cáo | `docs/dev/BRIEF.md` | P0-07…14 | — |

---

## P1 · Lõi (5 agent chạy song song sau P0)

### Agent A · Runtimes (`src/runtimes/`)

| | ID | Việc | Kết quả | Phụ thuộc | Xong khi |
|---|---|---|---|---|---|
| [x] | A-01 | `process.ts`: port `runChildProcess` của Paperclip (loại E). Không qua shell, tách nhóm tiến trình, SIGTERM → SIGKILL, giới hạn bộ đệm, xoá biến `CLAUDECODE*`, lọc biến môi trường | file + test | P0 | test hết giờ, huỷ và bộ đệm xanh |
| [x] | A-02 | `jsonl.ts` (đọc JSON từng dòng, bỏ dòng hỏng) + ghi lệnh vào nhật ký có che khoá bí mật | file + test | A-01 | test xanh |
| [x] | A-03 | `mock.ts`: trả lời theo kịch bản, có chế độ sinh chỉ thị để demo | file + test | A-01 | test xanh |
| [x] | A-04 | `claude.ts`: bộ tạo cờ (system prompt dạng file, resume, model, không công cụ, safe/full → `--restricted` / `--add-dir` / `--mcp-config` / `--strict-mcp-config` / `--allowedTools`); bộ đọc (`init`, `assistant`, `result`, lời từ chối); thử lại khi resume lỗi; phân loại lỗi | file + test với CLI giả | A-02 | test xanh |
| [x] | A-05 | `codex.ts`: `exec --json`, `-C`, `-s`, `--add-dir`, `--ignore-user-config`, `-c mcp_servers.*`, `shell_environment_policy`, resume; đọc `thread.started` / `item.completed` / `turn.completed` (trừ token cache) | file + test | A-02 | test xanh |
| [x] | A-06 | `grok.ts`: `--single`, `streaming-json`, `--rules @file`, `--cwd`, `--resume`, `--add-dir`, `--sandbox`, `--plugin-dir` cho MCP. **Không dùng `dontAsk`.** Đọc `text` / `thought` / `end` / `error`, xử lý ranh giới lượt | file + test | A-02 | test xanh |
| [x] | A-07 | `acp.ts`: client JSON-RPC tối giản (`initialize`, `session/new`, `session/load`, `session/prompt`, `session/update`, trả lời `request_permission`) | file + test với server ACP giả | A-01 | test xanh |
| [x] | A-08 | `hermes.ts`: chạy qua ACP với profile; cờ dự phòng sang `hermes chat -q` + `HERMES_EPHEMERAL_SYSTEM_PROMPT` | file + test | A-07 | test xanh |
| [x] | A-09 | `doctor()` cho 4 runtime, `index.ts` (danh sách runtime), `capabilities.enforces` | file + test | A-04…08 | test xanh |
| [x] | A-10 | **Kiểm thật**: 4 CLI trả lời "hello"; Claude `--restricted` không đọc được file ngoài thư mục cho phép; Codex không thấy MCP cá nhân; Grok `--sandbox` chặn tới đâu; Hermes nhận `mcpServers` | `docs/dev/runtime-verification.md` | A-09 | bảng 5.3 trong ARCHITECTURE hết ô "kiểm khi build" |

### Agent B · Agents, phân quyền, tầng dùng chung

| | ID | Việc | Kết quả | Phụ thuộc | Xong khi |
|---|---|---|---|---|---|
| [x] | B-01 | `agents/schema.ts` (zod, đủ trường ở ARCHITECTURE §4) | file + test | P0 | test xanh |
| [x] | B-02 | `agents/registry.ts`: đọc, kiểm tra, tạo / sửa / lưu trữ agent, tải lại, ghi lại yaml | file + test | B-01 | test xanh |
| [x] | B-03 | Đọc `config/brain.yaml`. `shared/brain.ts`: FTS bỏ dấu, quét tăng dần theo mtime, tìm lọc theo thư mục, đọc file có chặn `../` | file + test | P0 | gõ "khach hang" tìm ra "khách hàng" |
| [x] | B-04 | `shared/memory.ts`: bộ nhớ đội / riêng, FTS, ghim, lưu nguồn, nhớ lại top-k | file + test | P0 | test xanh |
| [x] | B-05 | `shared/skills.ts`: quét các thư mục skill (gồm skill của module), đọc frontmatter, lập danh mục, symlink vào `workspaces/<id>/.claude/skills`, dọn link cũ | file + test | B-02 | test xanh |
| [x] | B-06 | `shared/board.ts` (bảng hoạt động đội) | file + test | P0 | test xanh |
| [x] | B-07 | `access/connections.ts` (mcp / env / composio) + `access/composio.ts`, copy loại B từ `composio-credentials` và `fbstudio/composio` | file + test | P0 | test xanh, không gọi mạng |
| [x] | B-08 | `access/policy.ts`, hàm `resolveAccess`: glob thư mục, bộ nhớ, mẫu tool MCP, env, skill, scope module, safe/full | file + test | B-02, B-07 | test "không được cấp thư mục B thì readDirs không có B" |
| [x] | B-09 | `access/audit.ts` | file + test | P0 | test xanh |
| [x] | B-10 | `shared/context.ts`: hai profile `standard` và `lean` (ý tưởng `agent-context` của GỐC), giới hạn ký tự từng khối, đóng khung dữ liệu | file + test | B-03…08 | test: prompt không chứa ghi chú của thư mục chưa được cấp |
| [x] | B-11 | Dữ liệu mẫu: agent `main`, `coder`, `researcher`, `assistant`, `demo` (persona tiếng Việt); `config/brain.yaml` + `brain/` mẫu; vài skill mẫu; `connections.yaml` mẫu | file | B-01 | registry đọc được cả 5 agent |

### Agent C · Giao việc (`src/work/`, `main.ts`)

| | ID | Việc | Kết quả | Phụ thuộc | Xong khi |
|---|---|---|---|---|---|
| [x] | C-01 | `tasks.ts`: CRUD, trạng thái, lọc theo source / agent, cây việc con | file + test | P0 | test xanh |
| [x] | C-02 | `runs.ts` + `run_events` | file + test | C-01 | test xanh |
| [x] | C-03 | `comments.ts` + `attention.ts` (nguồn dữ liệu cho "Cần bạn") | file + test | C-01 | test xanh |
| [x] | C-04 | `directives.ts`: đọc và kiểm tra `<aios-task>`, `<aios-memory>`, `<aios-status>`. Chỉ đọc ở câu trả lời cuối; giới hạn độ sâu, số việc con, số vòng | file + test (có ca tấn công injection) | P0 | test xanh |
| [x] | C-05 | `dispatcher.ts`: nhận việc nguyên tử bằng `UPDATE … RETURNING`, giới hạn theo agent và toàn hệ thống, ưu tiên, huỷ, đánh thức ngay khi có việc mới | file + test | C-01 | test 2 dispatcher không nhận trùng việc |
| [x] | C-06 | `engine.ts`: 7 bước (ngân sách, quyền, ngữ cảnh, runtime, chỉ thị, ghi sổ, hook của module) | file + test với `mock` | C-02…05, A-03, B-08, B-10 | test xanh |
| [x] | C-07 | `team.ts`: song song + gộp, relay, chờ việc con và chạy lại để tổng hợp | file + test | C-06 | test luồng giao → waiting → tổng hợp |
| [x] | C-08 | `scheduler.ts`: cron + múi giờ, `skip_if_active`, `skip_missed`, chạy ngay | file + test | C-01 | test xanh |
| [x] | C-09 | `chat.ts`: cuộc trò chuyện, tin nhắn, nối phiên hoặc gửi kèm lịch sử | file + test | C-06 | test xanh |
| [x] | C-10 | Khôi phục khi khởi động lại, `stats.ts`, `main.ts` (thứ tự khởi động, tắt êm) | file + test | C-01…09 | test khôi phục một lần rồi chuyển `failed` |

### Agent D · Module runtime, API, CLI

| | ID | Việc | Kết quả | Phụ thuộc | Xong khi |
|---|---|---|---|---|---|
| [x] | D-01 | `modules/loader.ts`: tìm `modules/*/module.json`, kiểm tra, nạp phần server | file + test | P0 | test xanh |
| [x] | D-02 | `modules/lifecycle.ts`: Add (kiểm module phụ thuộc và kết nối; migration chỉ tạo bảng đã khai báo; chép agent mẫu và skill), Remove, Purge | file + test | D-01 | test Add → Remove → Purge |
| [x] | D-03 | Tạo context cho SDK: `db`, `tasks`, `agents.runLean` (qua Engine), `access.can`, `connections`, `memory`, `brain`, `settings`, `schedule`, `bus`, `audit`, `attention`, `modules.get`, `log` | file + test | D-01, C-06 (dùng stub khi C chưa xong) | test `runLean` tạo Task và trả kết quả |
| [x] | D-04 | `modules/compat/`: hiện thực mọi symbol trong P0-10 | file + test | D-03 | mỗi symbol có test |
| [x] | D-05 | `api/server.ts` (Hono, token, định dạng lỗi, phục vụ web) + `sse.ts` + chặn `/api/m/:id` khi module chưa Add | file + test | P0 | test xanh |
| [x] | D-06 | Route nhóm 1: health, runtimes, stats, attention, agents (+ xem trước quyền), connections | file + test | D-05 | test xanh |
| [x] | D-07 | Route nhóm 2: tasks (+ comments, team, cancel, retry, approve), runs, schedules | file + test | D-05 | test xanh |
| [x] | D-08 | Route nhóm 3: conversations, brain, memory, skills, board, audit, modules | file + test | D-05 | test xanh |
| [x] | D-09 | Test hợp đồng API so với `API.md` | test | D-06…08 | test xanh |
| [x] | D-10 | `cli/aios.ts` (agents, task, memory, brain, `module new / add / remove`) + `modules/_template/` | file + test | D-02 | `aios module new demo` ra module chạy được |

### Agent E · Web lõi (`web/src/`)

| | ID | Việc | Kết quả | Phụ thuộc | Xong khi |
|---|---|---|---|---|---|
| [x] | E-01 | **Viết lại loại C, giữ nguyên props**: `PageHeader`, `PageState`, `Toggle`, `ConfirmModal`, `Pill`, `Modal`, `toasts`, `useFetch`, `api`, `useDebounce`, `format`, `personalization`. Lấy props từ **chỗ gọi** trong code GỐC của bạn; không chép phần thân | file | P0 | typecheck với code copy ở E-02 |
| [x] | E-02 | Copy loại A: `page-context`, `ChatThread`, `RichTextEditor`, `MentionInput`, `FolderPicker`, `BrandIcons`, `chat-dock`; sửa import | file | E-01 | typecheck qua |
| [x] | E-03 | Khung app: layout, sidebar (nhóm lõi + nhóm module), router wouter, hook SSE, token màu Tailwind | file | E-01 | app chạy với API giả |
| [x] | E-04 | `module-host/`: `import.meta.glob`, đọc module đang bật từ `/api/modules`, sổ provides, khe widget | file | E-03 | module `_template` hiện được menu |
| [x] | E-05 | Trang **Tổng quan**: Cần bạn, chỉ số, hoạt động đội, widget, giao việc nhanh | trang | E-03 | hiện được với API giả |
| [x] | E-06 | Trang **Agents**: danh sách + chi tiết (persona, cài đặt, **tab Quyền** có huy hiệu cứng/mềm, lượt chạy, chat) | trang | E-03 | hiện được |
| [x] | E-07 | Trang **Công việc** (kanban) + **Chi tiết việc** (chữ chạy trực tiếp, bình luận, cây việc con, nút thao tác) + hộp thoại Hỏi cả nhóm / Relay | trang | E-03 | hiện được |
| [x] | E-08 | Trang **Lịch** và **Trò chuyện** | trang | E-03 | hiện được |
| [x] | E-09 | Trang **Second Brain**, **Bộ nhớ**, **Skills** | trang | E-03 | hiện được |
| [x] | E-10 | Trang **Kết nối**, **Nhật ký**, **Module** (Add / Remove / Purge, báo thiếu điều kiện), **Cài đặt** (doctor) | trang | E-04 | hiện được |
| [x] | E-11 | Lớp API giả cho dev và e2e; `vite build`; typecheck web | file | E-05…10 | build và typecheck sạch |

### Cổng P1 (Mình)

| | ID | Việc | Xong khi |
|---|---|---|---|
| [x] | G1-01 | typecheck + toàn bộ test + `check-provenance` | tất cả xanh |
| [x] | G1-02 | Chạy thật với `mock`: tạo agent → giao việc → `main` giao việc con → tổng hợp, xem trên giao diện | luồng chạy hết |
| [~] | G1-03 | Một việc thật qua mỗi CLI (Claude, Codex, Grok, Hermes) | 4/4 có kết quả, chi phí và token — **3/4 đạt**; Hermes chờ chủ đăng nhập nhà cung cấp mô hình (`hermes model`) |
| [x] | G1-04 | Thử chặn quyền: agent không được cấp thư mục B, hỏi về nội dung B | không lộ nội dung B; nhật ký ghi lại |
| [x] | G1-05 | Add / Remove `_template` trên giao diện, không khởi động lại | menu hiện và ẩn đúng |

---

## P2 · Module (5 agent chạy song song sau cổng P1)

**Ghi chú chung cho P2:**
- Module copy từ GỐC **giữ tên bảng cũ** (`fb_*`, `email_*`, `zalo_*`, `care_*`). `module.json` khai báo danh sách `tables`. Lifecycle chỉ cho tạo đúng các bảng này, và Purge chỉ xoá đúng các bảng này.
- Lượt agent đổi sang `ctx.agents.runLean`. Kiểm quyền bằng `ctx.access.can`.
- Test của phần đã xoá thì xoá theo, và ghi lý do vào `PORTING.md`.

### Agent CARE · `modules/care`

| | ID | Việc | Phụ thuộc | Xong khi |
|---|---|---|---|---|
| [x] | CARE-01 | Chạy copy theo manifest (backend + web + test) | P0-14 | file đúng manifest; có `PORTING.md` |
| [x] | CARE-02 | Xoá loại F: `bridge`, `legacy-delivery`, `rehearsal`, `bench`, `cutover*`, `legacy-compat*`, `app-bridge*`, `connectors/telegram*`, `owner-alerts`, `dto-telegram*`, `dto-bridge`, phần telegram và bridge ở web | CARE-01 | không còn import trỏ vào phần đã xoá |
| [x] | CARE-03 | Nối import backend → SDK / compat; `persistence` dùng `ctx.db`; migration; khai báo `tables` | CARE-02 | typecheck module qua |
| [x] | CARE-04 | `agent-runner-engine` → `ctx.agents.runLean`; giữ cách đọc JSON output; kiểm scope `reply.draft` / `reply.send` (thiếu `send` thì hạ xuống nháp) | CARE-03 | test lượt agent xanh |
| [x] | CARE-05 | `provides`: sổ kênh `careChannel` + API `ingest`; giữ `connectors/contract.ts` và fake connector | CARE-03 | test fake connector xanh |
| [x] | CARE-06 | `module.json` (scope, tables, agent mẫu, skill), `server/index.ts` (routes, worker start / stop) | CARE-03 | Add / Remove chạy |
| [x] | CARE-07 | Web: copy trang, component và lib; sửa import; `web/index.tsx` (menu, route, widget "Khách đang chờ" và "Nháp chờ duyệt"); điểm mở rộng `care.channelPanel` | CARE-06 | trang hiện được |
| [x] | CARE-08 | Agent mẫu `cskh` + skill `tra-loi-khach` (từ prompt chăm sóc khách của GỐC) | CARE-06 | được chép khi Add |
| [x] | CARE-09 | Sửa test đã copy cho xanh | CARE-04…07 | toàn bộ test của module xanh |
| [x] | CARE-10 | e2e với fake connector: tin đến → lượt lean → nháp → duyệt → gửi; tự động có Huỷ; giờ nghỉ chuyển thành nháp; tiếp quản dừng AI | CARE-09 | 4 kịch bản xanh |
| [x] | CARE-11 | `README.md` của module | CARE-10 | — |

### Agent ZALO · `modules/zalo` (AGPL-3.0)

| | ID | Việc | Phụ thuộc | Xong khi |
|---|---|---|---|---|
| [x] | ZALO-01 | Copy theo manifest (`src/zalo` + `connectors/zalo` + web + test); tách SQL `@zalo-*` từ `db.ts` | P0-14 | file đúng manifest |
| [x] | ZALO-02 | Kiểm phụ thuộc rồi xoá loại F: `responder`, `gate`, `agent-turn`, `care-fence`, `care-delivery`, `daemon-care`, `routes-customer-care`, trang `ZaloAgents`, `ZaloChat` | ZALO-01 | không còn import trỏ vào phần đã xoá |
| [x] | ZALO-03 | `store.ts` + migration từ SQL đã tách; khai báo `tables` | ZALO-01 | typecheck qua |
| [x] | ZALO-04 | Daemon và supervisor → `start` / `stop` của module (tiến trình con, tự khởi động lại khi sập); token điều khiển và cổng lấy từ settings | ZALO-03 | daemon bật và tắt theo Add / Remove |
| [x] | ZALO-05 | Nối import → compat (logger, config, kill switch → settings, env, platform, mã hoá) | ZALO-03 | typecheck qua |
| [x] | ZALO-06 | Connector cho care: đăng ký kênh khi `care` đã Add; tin đến → `care.ingest`; gửi → sender (có giới hạn chống khoá); đưa ảnh cho lượt lean (`turn-images`) | ZALO-05, CARE-05 | test với daemon giả xanh |
| [x] | ZALO-07 | Route và worker marketing: mẫu tin, gửi nhóm, gửi 1-1, sinh nhật; giờ nghỉ; ngân sách 60% | ZALO-05 | test copy xanh |
| [x] | ZALO-08 | Web: `ZaloAccounts`, 4 trang `Marketing*`, `components/marketing`, panel `care-channels/zalo` qua provides, `lib/zalo`, `richText`; `web/index.tsx` | ZALO-06 | trang hiện được |
| [x] | ZALO-09 | `LICENSE` (AGPL-3.0) + `NOTICE` liệt kê 15 file có gốc ZaloCRM; agent mẫu `zalo-care` + skill `zalo-reply` | ZALO-01 | `check-provenance` qua |
| [x] | ZALO-10 | Sửa test cho xanh; kiểm tạo mã QR thật (**không đăng nhập**); `README.md` | ZALO-04…09 | test xanh, QR hiện trên giao diện |

### Agent GMAIL · `modules/gmail` (cần `care`)

| | ID | Việc | Phụ thuộc | Xong khi |
|---|---|---|---|---|
| [x] | GMAIL-01 | Copy theo manifest (`src/email` phần giữ + `connectors/email` + web + test); tách SQL `@email-*` | P0-14 | file đúng manifest |
| [x] | GMAIL-02 | Xoá loại F (`responder`, `agent-turn`, `gate`, `worker`, `notify`, trang `EmailInbox` và `EmailAgents`); `store` + migration + `tables` | GMAIL-01 | typecheck qua |
| [x] | GMAIL-03 | Composio qua `ctx.connections`; worker đồng bộ 2 phút; connector → `care.ingest`; trả lời đúng luồng thư, kèm chữ ký | GMAIL-02, CARE-05 | test với Composio giả xanh |
| [x] | GMAIL-04 | Web: trang tài khoản Gmail + panel care; `module.json` khai báo cần `care` | GMAIL-03 | Add báo thiếu khi chưa có `care` |
| [x] | GMAIL-05 | Sửa test cho xanh; `README.md` | GMAIL-04 | test xanh |

### Agent MKT · `modules/marketing`

| | ID | Việc | Phụ thuộc | Xong khi |
|---|---|---|---|---|
| [x] | MKT-01 | Copy theo manifest (`fbstudio` core, comments, analytics + web + test + skill); tách SQL `@fbstudio-*` trừ ads | P0-14 | file đúng manifest |
| [x] | MKT-02 | Xoá loại F (whop, nền tảng khác, `fbstudio-cli`); `store` + migration + `tables` | MKT-01 | typecheck qua |
| [x] | MKT-03 | Dùng client Composio chung; giữ `graphAsPage`; worker đăng bài, poll bình luận, đồng bộ phân tích; kill switch → settings | MKT-02, B-07 | test copy xanh |
| [x] | MKT-04 | Lượt agent (trả lời bình luận, phân tích) → `runLean`; chat ở Kho nội dung → chat lõi (`ChatThread`) | MKT-03 | test lượt agent xanh |
| [x] | MKT-05 | `notify` → attention; duyệt bài theo Page | MKT-03 | test xanh |
| [x] | MKT-06 | Web: trang `fb/*` (trừ Ads), `components/fb` (trừ `ads`), `lib/fbstudio`, `SocialOverview` chỉ phần Facebook; `web/index.tsx` | MKT-03 | trang hiện được |
| [x] | MKT-07 | Skill `fb-content`, `fb-comment-reply`; agent mẫu `content-fb`, `fb-analyst` | MKT-01 | được chép khi Add |
| [x] | MKT-08 | `provides.topPosts` cho module `ads` | MKT-03 | test xanh |
| [x] | MKT-09 | Sửa test cho xanh (**không gọi Facebook thật**); `README.md` | MKT-04…08 | test xanh |

### Agent ADS · `modules/ads`

| | ID | Việc | Phụ thuộc | Xong khi |
|---|---|---|---|---|
| [x] | ADS-01 | Copy theo manifest (`fbstudio/ads` + web Ads + chart và common cần dùng + test); tách SQL `@fbstudio-*:ads` | P0-14 | file đúng manifest |
| [x] | ADS-02 | `store` + migration + `tables`; client Composio chung; worker chụp số liệu mỗi giờ; quy tắc R1–R5 | ADS-01, B-07 | test quy tắc và chỉ số xanh |
| [x] | ADS-03 | Đánh giá → `runLean`; đề xuất kèm nút "Đã xử lý" / "Bỏ qua 24 giờ" | ADS-02 | test xanh |
| [x] | ADS-04 | Bài organic nên chạy quảng cáo, lấy qua `ctx.modules.get('marketing')`; không có `marketing` thì ẩn | ADS-02, MKT-08 | test cả hai trường hợp |
| [x] | ADS-05 | Web `FbAds` + `components/fb/ads`; `web/index.tsx`; agent mẫu `ads-analyst` | ADS-02 | trang hiện được |
| [x] | ADS-06 | Test khẳng định **không có lệnh ghi nào sang Meta**; sửa test cho xanh; `README.md` | ADS-03…05 | test xanh |

### Cổng P2 (Mình)

| | ID | Việc | Xong khi |
|---|---|---|---|
| [x] | G2-01 | Toàn bộ test + `check-provenance` + typecheck | xanh |
| [~] | G2-02 | e2e: Add cả 5 module trên giao diện → cấp scope cho agent `cskh` → tin Zalo giả → nháp → duyệt → gửi qua daemon giả | luồng chạy hết |
| [x] | G2-03 | Remove `zalo` vẫn giữ dữ liệu; Purge xoá đúng bảng của module | kiểm bằng SQL |
| [x] | G2-04 | Đi qua từng trang module, chụp màn hình gửi bạn xem | ảnh đủ các trang |

---

## P3 · Ghép, thử thật, tài liệu (Mình)

| | ID | Việc | Xong khi |
|---|---|---|---|
| [x] | P3-01 | Sửa lỗi tích hợp còn lại | không còn lỗi đã biết |
| [x] | P3-02 | e2e Playwright cho các luồng chính (lõi + care) | xanh |
| [~] | P3-03 | Composio: đọc danh sách Page (đăng/xoá bài chưa làm — chủ chọn chỉ thử phần đọc) | ✅ đọc được 4 Page thật |
| [~] | P3-04 | Gmail: liệt kê hộp thư qua Composio (chưa đồng bộ thư) | ✅ thấy hộp thư Gmail của chủ ở trạng thái ACTIVE (4 kết nối trùng trên Composio) |
| [~] | P3-05 | Meta Ads: đồng bộ danh sách tài khoản (chưa chụp số liệu) | ✅ kết nối ACTIVE, 1 tài khoản `con_ads_chienthang` |
| [ ] | P3-06 | **(hỏi bạn)** Zalo: bạn quét QR một nick thử; chỉ nhắn cho chính bạn | tin vào hộp thư, nháp được tạo |
| [x] | P3-07 | `THIRD_PARTY_NOTICES.md`, LICENSE của lõi (**chờ bạn chọn**), `README.md` cài đặt | — |
| [x] | P3-08 | Bài 1: Kiến trúc AIOS-Lite | `docs/lessons/01-*.md` |
| [x] | P3-09 | Bài 2: Khai báo agent | `docs/lessons/02-*.md` |
| [x] | P3-10 | Bài 3: Phân quyền (thư mục, MCP, scope module) | `docs/lessons/03-*.md` |
| [x] | P3-11 | Bài 4: Thêm runtime mới | `docs/lessons/04-*.md` |
| [x] | P3-12 | Bài 5: Giao việc và chỉ thị | `docs/lessons/05-*.md` |
| [x] | P3-13 | Bài 6: Bộ nhớ, Second Brain, skill | `docs/lessons/06-*.md` |
| [x] | P3-14 | Bài 7: Viết module từ `_template` | `docs/lessons/07-*.md` |
| [x] | P3-15 | Bài 8: Đọc module `care` làm ví dụ lớn | `docs/lessons/08-*.md` |

---

**Tổng:** 15 (P0) + 52 (P1) + 5 (cổng P1) + 41 (P2) + 4 (cổng P2) + 15 (P3) = **132 task**.
