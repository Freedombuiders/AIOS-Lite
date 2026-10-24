# AIOS-Lite

AIOS-Lite là một **hệ điều hành cho đội agent**, viết nhỏ gọn để làm template dạy học. Bạn khai báo các agent (chạy bằng Claude Code, Codex, Grok hoặc Hermes), giao việc cho chúng, cấp cho từng agent đúng những gì nó được xem và được làm, và thêm các nghiệp vụ như Chăm sóc khách hàng hay Marketing bằng một cú bấm **Add**.

Lõi đủ nhỏ để đọc hiểu trong một buổi. Nghiệp vụ nằm trong **module**: cần cái nào thì Add cái đó, không cần thì thôi.

- Tài liệu thiết kế: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), danh mục module: [docs/MODULES.md](docs/MODULES.md).
- Học từng bước: [docs/lessons/](docs/lessons/README.md) (8 bài, tiếng Việt).

## Mô hình bốn tầng và module

```
┌──────────────────────────────────────────────────────────────┐
│ TẦNG APP      web/       giao diện Preact: Tổng quan, Agents,  │
│                          Công việc, Lịch, Trò chuyện, Brain…   │
├──────────────────────────────────────────────────────────────┤
│ MODULE        modules/   care · zalo · gmail · marketing ·     │
│  (bấm Add)               ads · _template — chỉ dùng Module SDK │
├──────────────────────────────────────────────────────────────┤
│ TẦNG GIAO VIỆC  src/work/   Task → Dispatcher → Engine → Run   │
├───────────────┬──────────────────┬───────────────────────────┤
│ TẦNG AGENT    │ KIỂM SOÁT TRUY CẬP │ TẦNG DÙNG CHUNG           │
│ src/agents/   │ src/access/        │ src/shared/               │
│ agent.yaml    │ ai được xem/làm gì │ Second Brain · bộ nhớ ·   │
│               │                    │ skill · bảng đội          │
├───────────────┴──────────────────┴───────────────────────────┤
│ TẦNG RUNTIME  src/runtimes/   claude · codex · grok · hermes · mock │
└──────────────────────────────────────────────────────────────┘
```

Sáu nguyên tắc giữ cho hệ thống dễ hiểu (chi tiết ở [ARCHITECTURE.md](docs/ARCHITECTURE.md) và [bài 1](docs/lessons/01-kien-truc-aios-lite.md)):

1. Agent khai báo ở một nơi: `agents/<id>/agent.yaml` và `persona.md`.
2. Mọi lượt chạy, kể cả do module tạo, đi qua một cổng duy nhất là `src/work/engine.ts`.
3. Chỉ có một mô hình việc: Task và Run.
4. Bộ nhớ, Second Brain và skill được nạp ở cổng chạy, nên runtime nào cũng nhận như nhau.
5. `src/access/policy.ts` tính quyền, adapter dịch quyền thành cờ của từng CLI, mọi thứ được ghi nhật ký.
6. Mặc định không cấp gì. Hành động ra ngoài (gửi Zalo, email, đăng Facebook) mặc định chỉ là nháp.

## Yêu cầu

| Thứ | Bắt buộc? | Ghi chú |
|---|---|---|
| Node.js 22 trở lên | Có | `node -v` phải ra v22.x. Xem `engines` trong `package.json`. |
| npm | Có | Đi kèm Node. |
| Ít nhất một CLI agent | Không | Chạy thử không cần CLI nào: agent `demo` dùng runtime `mock`. |

Bốn CLI agent mà AIOS-Lite có thể gọi. Bạn tự cài và đăng nhập; AIOS-Lite chỉ chạy chúng như tiến trình con:

| Runtime | Cài | Đăng nhập |
|---|---|---|
| `claude` (Claude Code) | `npm i -g @anthropic-ai/claude-code` | `claude auth login`, hoặc đặt `ANTHROPIC_API_KEY` |
| `codex` (Codex) | `npm i -g @openai/codex` | `codex login`, hoặc đặt `OPENAI_API_KEY` |
| `grok` (Grok Build) | xem https://x.ai/cli | `grok login`, hoặc đặt `XAI_API_KEY` |
| `hermes` (Hermes / Rocket Agent) | cài theo hướng dẫn của Hermes | `hermes model` hoặc `hermes auth add …` |

Agent mẫu `assistant` (Hermes) đang **tắt** (`enabled: false`). Muốn dùng: cài Hermes, chạy `hermes model` hoặc `hermes auth add …` để đăng nhập, rồi đặt `enabled: true` trong `agents/assistant/agent.yaml` (hoặc bật ở trang Agents) và `POST /api/agents/reload`.

Sau khi cài, vào **Cài đặt** trên giao diện (hoặc mở `http://127.0.0.1:4380/api/runtimes` khi đang chạy) để xem kết quả kiểm tra của từng CLI: có lệnh không, phiên bản, đã đăng nhập chưa. Thêm `?probe=1` vào địa chỉ đó thì hệ thống gửi thử một câu "hello" (có tốn một lượt gọi thật).

## Cài đặt và chạy

```bash
npm install
cp .env.example .env        # mọi biến đều có mặc định, sửa nếu cần
npm run dev
```

`npm run dev` chạy hai thứ cùng lúc:

| Thành phần | Địa chỉ | Ghi chú |
|---|---|---|
| Giao diện (Vite) | http://localhost:5173 | Mở trình duyệt vào đây khi phát triển. Mọi lời gọi `/api` được chuyển sang API. |
| API (`tsx watch`) | http://127.0.0.1:4380 | Tự khởi động lại khi bạn sửa file trong `src/`. |

Kiểm tra nhanh: `curl http://127.0.0.1:4380/api/health` trả `{"ok":true,...}`.

**Đổi cổng.** Đặt `AIOS_PORT` trong `.env` là đủ cho API và lệnh `aios`. Riêng giao diện Vite đọc `AIOS_PORT` từ **biến môi trường của shell**, không đọc `.env`, nên khi đổi cổng hãy chạy `AIOS_PORT=4391 npm run dev` để Vite chuyển `/api` đúng nơi.

### Chạy bản build (một cổng)

```bash
npm run build
npm start
```

`npm run build` biên dịch TypeScript sang `dist/` và đóng gói giao diện vào `dist/web/`. `npm start` chạy `node dist/src/main.js` và phục vụ cả API lẫn giao diện ở **cùng một cổng** (mặc định http://127.0.0.1:4380). Khi chạy bản build, module cũng được nạp từ `dist/modules/`, vì vậy **sau khi thêm hoặc sửa module phải build lại** rồi mới `npm start`.

### Cấu hình trong `.env`

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `AIOS_PORT`, `AIOS_HOST` | `4380`, `127.0.0.1` | Địa chỉ nghe. Chỉ nghe trên máy này theo mặc định. |
| `AIOS_TOKEN` | (trống) | Nếu đặt, mọi lời gọi API phải kèm `Authorization: Bearer <token>`. |
| `AIOS_MAX_PARALLEL` | `3` | Số lượt agent chạy cùng lúc trên toàn hệ thống. |
| `AIOS_DATA_DIR` | `./data` | Nơi chứa `aios.db` (SQLite) và dữ liệu module. |
| `AIOS_SKILLS_DIRS` | `./skills` | Thư viện skill (nhiều thư mục thì ngăn bằng dấu phẩy). |
| `AIOS_MAX_DELEGATION_DEPTH`, `AIOS_MAX_CHILDREN_PER_RUN` | `3`, `5` | Giới hạn giao việc giữa các agent. |
| `AIOS_RUN_TIMEOUT_SEC` | `900` | Thời gian tối đa một lượt chạy. |

Khoá bí mật (khoá API, token) chỉ nằm trong `.env` và không bao giờ đi vào prompt hay nhật ký.

## Bước đầu tiên

1. **Mở Tổng quan.** Vào http://localhost:5173. Mục **Cần bạn** ở đầu trang gom mọi thứ cần bạn xử lý: việc chờ duyệt, việc thất bại, nháp trả lời khách của module.
2. **Giao việc cho `demo`.** Agent `demo` chạy bằng runtime giả lập nên không cần CLI hay khoá API. Ở khung **Giao việc nhanh** chọn `demo`, gõ một yêu cầu, bấm giao. Mở **Công việc** để xem trạng thái đi từ `queued` sang `running` rồi `done`, và xem lượt chạy ở trang chi tiết.

   Cùng việc đó bằng dòng lệnh (khi API đang chạy):

   ```bash
   npm run aios -- task "Tóm tắt mục tiêu quý này" --agent demo --wait
   ```

   Runtime `mock` hiểu vài từ khoá để bạn xem hệ thống phản ứng: thêm `#memory:điều cần nhớ` để agent ghi bộ nhớ, `#review` để việc dừng ở trạng thái chờ duyệt, `#delegate:<id-agent>` để giao việc con, `#fail` để thử lỗi.
3. **Thêm một module.** Vào **Module**, bấm **Thêm** ở `care` (hộp thư chăm sóc khách), giữ ô "cài agent mẫu". Menu **Sales** hiện ra ngay, không cần khởi động lại. Cùng việc đó bằng dòng lệnh:

   ```bash
   npm run aios -- module list
   npm run aios -- module add care --agents
   ```

   Gỡ bằng `npm run aios -- module remove care`: module tắt nhưng dữ liệu còn nguyên. Chỉ nút **Xoá dữ liệu** (phải gõ lại tên module) mới xoá bảng.
4. **Làm module của riêng bạn.** `npm run aios -- module new ten-module` tạo khung từ `modules/_template/`. Xem [bài 7](docs/lessons/07-viet-module-tu-template.md).

## Cấu trúc thư mục

```
AIOS-Lite/
├── agents/<id>/        agent.yaml + persona.md: mỗi thư mục là một agent
├── skills/<id>/        SKILL.md: thư viện skill dùng chung
├── brain/              Second Brain mẫu (có thể trỏ sang vault Obsidian thật)
├── config/
│   ├── brain.yaml      các thư mục Second Brain
│   └── connections.yaml  MCP, khoá API, Composio (chỉ ghi TÊN biến .env)
├── modules/<id>/       care · zalo · gmail · marketing · ads · _template
│   └── _lib/           mã dùng chung cho module (không phải module)
├── workspaces/<agent>/ thư mục làm việc của từng agent (không đưa vào git)
├── data/               aios.db và dữ liệu module (không đưa vào git)
├── src/
│   ├── core/           cấu hình, DB, sự kiện, kiểu dữ liệu, che khoá bí mật
│   ├── agents/         schema agent.yaml (zod) và registry
│   ├── access/         policy (tính quyền), connections, audit
│   ├── runtimes/       claude · codex · grok · hermes · mock + bộ chạy tiến trình chung
│   ├── shared/         brain · memory · skills · board · context builder
│   ├── work/           tasks · runs · engine · dispatcher · directives · team · scheduler · chat
│   ├── modules/        Module SDK, loader, manager (Add/Remove/Purge)
│   ├── api/            server Hono và các route /api/*
│   ├── cli/            lệnh `aios`
│   └── main.ts         lắp ráp mọi dịch vụ và khởi động
├── web/src/            giao diện Preact (trang lõi + chỗ cắm cho module)
├── scripts/            công cụ phụ (kiểm tra nguồn gốc mã)
├── test-fixtures/      CLI giả dùng trong test runtime
└── docs/               tài liệu thiết kế và bài học
```

## Các lệnh hay dùng

| Lệnh | Việc làm |
|---|---|
| `npm run dev` | Chạy API (:4380) và giao diện (:5173) ở chế độ phát triển |
| `npm run build` | Biên dịch server và đóng gói giao diện vào `dist/` |
| `npm start` | Chạy bản build ở một cổng |
| `npm test` | Toàn bộ test (Vitest cho server và web, test của `scripts/`, kiểm tra nguồn gốc mã) |
| `npm run test:unit` | Chỉ phần Vitest |
| `npx vitest run modules/care` | Test của một module (hoặc một thư mục bất kỳ) |
| `npm run typecheck` | Kiểm tra kiểu cho cả server và web |
| `npm run aios -- <lệnh>` | Điều khiển AIOS-Lite đang chạy (xem dưới) |

Lệnh `aios` nói chuyện với API đang chạy (đọc `AIOS_HOST`, `AIOS_PORT`, `AIOS_TOKEN` từ `.env`), trừ `module new` chạy được khi chưa bật server:

```
npm run aios -- agents                                   liệt kê agent
npm run aios -- task "<yêu cầu>" [--agent id] [--wait]   giao việc (--wait: chờ kết quả)
npm run aios -- tasks [--status queued,running] [--limit 20]
npm run aios -- memory add "<nội dung>" [--agent id] [--pin]
npm run aios -- memory search <từ khoá>
npm run aios -- brain search <từ khoá>                   tìm trong Second Brain
npm run aios -- module list | add <id> [--agents] | remove <id> | new <id>
```

Lưu ý: `npm test` đọc thư mục `agents/` thật để kiểm tra các agent mẫu, nên nếu bạn tạo hoặc xoá agent trong thư mục này, một vài test về "agent mẫu" có thể báo lệch. Hãy thử trên bản sao hoặc đặt `AIOS_AGENTS_DIR` sang thư mục khác khi chạy ứng dụng.

## Module có sẵn

| Module | Nhóm | Cần có | Làm gì |
|---|---|---|---|
| `care` | Sales | — | Hộp thư chung, agent soạn nháp hoặc tự trả lời, hồ sơ khách 360 |
| `zalo` | Sales | — | Nick Zalo, chống khoá nick, gửi tin hàng loạt; cấp kênh Zalo cho `care` |
| `gmail` | Sales | `care` + khoá Composio | Đưa thư Gmail vào hộp thư của `care` |
| `marketing` | Marketing | khoá Composio | Soạn, lên lịch, đăng bài Facebook Page; bình luận AI |
| `ads` | Marketing | khoá Composio | Theo dõi quảng cáo Meta, chấm điểm bằng quy tắc (chỉ đọc) |
| `radar` | Marketing | Grok CLI; Apify/RSSHub tuỳ chọn | Nghiên cứu thị trường hằng ngày (3 phiên), báo cáo nỗi đau và xu hướng |
| `kol` | AI Studio | khoá Composio; fal/Higgsfield/Gemini tuỳ chọn | KOL ảo giữ khuôn mặt: hồ sơ, tạo ảnh/video, thư viện, bài đăng (qua `marketing`) |
| `video` | AI Studio | ffmpeg; HeyGen/Veo/fal tuỳ chọn | Dựng video quay sẵn, viết kịch bản và sản xuất video cùng KOL |
| `finance` | Finance | ERP/Whop MCP tuỳ chọn | P&L và dòng tiền, mô hình kinh doanh, sổ thu chi, đọc ERP (chỉ đọc) |
| `_template` | — | — | Khuôn để tạo module mới |

Khoá Composio nhập ở trang **Kết nối**; xem [docs/MODULES.md](docs/MODULES.md) để biết chi tiết từng module.

Ngoài module, lõi còn có **Chi phí AI** (`/usage`, `/budgets`: chi phí theo agent và hạn mức tháng), **Chợ Agent** (`/agent-market`), **Gói Team** (`/teams`: cài cả nhóm agent dựng sẵn, lịch để tắt) và **Đề xuất cải tiến** (`/recos`).

## Integrations (Pancake, Botcake, Composio…)

Vào **Kết nối → Integrations**, nhập key, bấm **Lưu & kiểm tra**. Sau đó vào **Agents → <agent> → Quyền → Integration** để chọn mức quyền: Tắt, Chỉ đọc, Hỏi trước, hoặc Đọc & ghi. Agent gọi lệnh qua tool MCP `aios-integrations` (cần runtime có MCP: Claude, Codex, Hermes; Grok chặn mềm). Lệnh chờ duyệt nằm ở tab **Chờ duyệt** và ở mục **Cần bạn**. Chi tiết: `docs/ARCHITECTURE.md` §5.3b.

## Giấy phép

- **Lõi AIOS-Lite** theo giấy phép **MIT**, © 2026 Tony Hoang (xem [LICENSE](LICENSE)). Đây là quyết định của chủ dự án. Repo hiện nằm ở GitHub riêng tư `hoanghd218/AIOS-Lite` và dự kiến mở mã nguồn sau.
- **`modules/zalo/` theo AGPL-3.0**, vì có mã dẫn xuất từ ZaloCRM. Toàn văn ở [modules/zalo/LICENSE](modules/zalo/LICENSE), thông báo ở [modules/zalo/NOTICE](modules/zalo/NOTICE). Nếu bạn phát hành bản có kèm module này hoặc chạy bản đã sửa như một dịch vụ mạng, bạn phải cung cấp mã nguồn của module `zalo`; muốn tránh điều đó, loại thư mục `modules/zalo/` khỏi bản phát hành.
- Mã và thư viện của bên thứ ba (Paperclip, các gói npm…) được liệt kê ở [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
