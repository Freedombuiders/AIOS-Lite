# AIOS-Lite — Kiến trúc (bản chốt)

> **Bản 3, chốt ngày 24/10/2026.** Danh mục module: xem [MODULES.md](MODULES.md).
>
> **Thay đổi so với bản 2:**
> - Bỏ "không gian theo công ty". Second Brain là nhiều thư mục, phân quyền theo từng thư mục.
> - Thêm **hệ thống module "bấm Add"**.
> - Mang các phần Ads, Marketing, Chăm sóc khách hàng và Zalo từ bản gốc sang thành module.

## 0. Mục tiêu

AIOS-Lite là **template dạy học**. Lõi nhỏ, học viên đọc hiểu trong một buổi. Các nghiệp vụ (Marketing, Ads, Chăm sóc khách, Zalo…) là **module**: cần cái nào thì bấm **Add**.

- **4 runtime:** Claude Code, Codex, Grok (Grok Build CLI), Hermes. Thêm runtime mới là một file adapter trong `src/runtimes/`, cộng khai báo id ở `src/core/types.ts`, đăng ký ở `src/runtimes/index.ts` và nhãn ở web (xem `docs/lessons/04-them-runtime-moi.md`).
- **Kiểm soát truy cập theo agent, mặc định không cấp gì.** Phân quyền cho:
  - thư mục Second Brain (đọc, ghi);
  - bộ nhớ;
  - MCP (đến từng tool);
  - khoá API;
  - skill;
  - dữ liệu của từng module (ví dụ: được đọc hộp thư Zalo không, được gửi tin hay chỉ soạn nháp).
- **Dùng chung:** thư viện skill dùng chung cho mọi agent; bộ nhớ đội và Second Brain dùng chung trong phạm vi quyền.
- **Không có:** War Room, Meet, Daily, avatar, Grok Bot.
- **Quy mô thực tế (không kể test):** lõi `src/` khoảng 9 nghìn dòng; mỗi module từ vài nghìn dòng (`ads`, `gmail`) đến vài chục nghìn dòng (`care` lớn nhất, xem bảng ở `MODULES.md`).

### Sáu nguyên tắc

| # | Nguyên tắc | Nghĩa là |
|---|---|---|
| 1 | **Một nơi khai báo agent** | `agents/<id>/agent.yaml` + `persona.md` |
| 2 | **Một cổng chạy** | Mọi lượt chạy, kể cả do module tạo, đều đi qua `work/engine.ts` |
| 3 | **Một mô hình việc** | Task + Run. Chat, lịch, giao việc giữa agent, hỏi cả nhóm, và việc do module tạo (ví dụ trả lời tin khách) đều là Task |
| 4 | **Một tầng dùng chung** | Bộ nhớ, Second Brain và skill được nạp ở cổng chạy, nên runtime nào cũng nhận như nhau |
| 5 | **Policy quyết định, adapter thực thi** | `access/policy.ts` tính quyền; adapter dịch quyền thành cờ của CLI; mọi thứ được ghi nhật ký |
| 6 | **Module chỉ nói chuyện với lõi qua SDK** | Module không import code bên trong lõi, và không gọi runtime trực tiếp. Muốn agent làm gì thì tạo Task qua SDK |

**Agent là cấu hình, không phải tiến trình.** Cả hệ thống là một tiến trình Node. Mỗi lượt chạy là một tiến trình con của CLI tương ứng. Riêng module nào cần giữ kết nối lâu (Zalo) thì tự quản lý tiến trình con của mình.

---

## 1. Sơ đồ

```
┌───────────────────────────────────────────────────────────────────────────┐
│ TẦNG APP — web/                                                            │
│  LÕI: Tổng quan & Cần bạn · Agents · Công việc · Lịch · Trò chuyện ·        │
│       Second Brain · Bộ nhớ · Skills · Kết nối · Nhật ký · Module (bấm Add) │
│  MODULE (hiện khi đã Add): Sales › Hộp thư, Khách hàng, Zalo…               │
│                            Marketing › Nội dung FB, Bình luận AI, Ads…      │
└───────────────▲───────────────────────────────────────────────────────────┘
                │ REST /api/* (lõi) · /api/m/<module>/* (module) · SSE /api/events
┌───────────────┴───────────────────────────────────────────────────────────┐
│ MODULE — modules/<id>/   (care · zalo · gmail · marketing · ads · …)        │
│  server: routes · workers · migrations · kênh (channel) · hook khi Task xong│
│  web: trang · mục menu · widget Tổng quan · agent mẫu · skill               │
│        │ chỉ dùng Module SDK (ctx.tasks, ctx.access, ctx.connections, …)    │
├────────▼──────────────────────────────────────────────────────────────────┤
│ TẦNG GIAO VIỆC — src/work/                                                 │
│  [tasks] ─► Dispatcher ─► ENGINE ─► [runs] ─► [audit_log]                   │
│                            1. tính quyền   2. gom ngữ cảnh (standard | lean)│
│                            3. gọi runtime  4. chỉ thị → việc con / bộ nhớ   │
│                            5. báo hook của module đã tạo Task                │
├──────────────┬────────────────────────┬───────────────────────────────────┤
│ TẦNG AGENT   │ KIỂM SOÁT TRUY CẬP     │ TẦNG DÙNG CHUNG                    │
│ agents/*.yaml│ src/access/            │ src/shared/                        │
│ Registry     │ thư mục · bộ nhớ · MCP │ Second Brain (nhiều thư mục) ·     │
│              │ · khoá · skill ·       │ Bộ nhớ · Thư viện skill ·          │
│ TẦNG RUNTIME │ quyền dữ liệu module   │ Bảng hoạt động đội · Context       │
│ claude·codex·│ → EffectiveAccess      │                                    │
│ grok·hermes· │                        │                                    │
│ mock         │                        │                                    │
└──────────────┴────────────────────────┴───────────────────────────────────┘
       ▼ tiến trình con, cờ quyền do adapter dịch ra
 claude -p │ codex exec │ grok --prompt-file │ hermes acp / chat -q
```

---

## 2. Cấu trúc thư mục

```
AIOS-Lite/
├── config/
│   ├── brain.yaml            ← các thư mục Second Brain (Cá nhân, Công ty A, Công ty B…)
│   └── connections.yaml      ← MCP, khoá API, Composio (chỉ ghi TÊN biến .env)
├── agents/<id>/              ← khai báo agent
├── skills/<id>/SKILL.md      ← thư viện skill dùng chung
├── brain/                    ← Second Brain mẫu (trỏ sang vault Obsidian thật cũng được)
├── modules/<id>/             ← MODULE: care · zalo · gmail · marketing · ads · _template
├── workspaces/<agent-id>/    ← thư mục làm việc của từng agent (không đưa vào git)
├── data/                     ← aios.db, file media của module (không đưa vào git)
├── src/
│   ├── core/       config · db · events · types · deps · redact
│   ├── agents/     schema (zod) · registry
│   ├── access/     policy · connections · audit
│   ├── runtimes/   contracts · process · jsonl · shared · probe · claude · codex · grok · hermes (+acp) · mock · index
│   ├── shared/     brain · memory · skills · board · context
│   ├── work/       tasks · runs · comments · engine · dispatcher · directives · team · scheduler · chat · stats
│   ├── modules/    sdk.ts (hợp đồng cho module) · contracts.ts · loader.ts · manager.ts (add/remove/purge, mount route) · context.ts (ctx của module) · settings.ts · outbound.ts · compat/
│   ├── api/        server · routes/* · sse
│   ├── cli/        aios.ts  (gồm `aios module new <id>` để tạo khung module)
│   └── main.ts
├── web/src/        pages/* (lõi) · module-host/ (nạp phần web của module) · lib/api.ts · App.tsx
└── docs/           ARCHITECTURE.md · MODULES.md · lessons/ (bài học tiếng Việt)
```

---

## 3. Second Brain nhiều thư mục

```yaml
# config/brain.yaml
folders:
  - id: ca-nhan
    name: Cá nhân
    path: ./brain/ca-nhan
  - id: cong-ty-a
    name: Công ty A — Nội thất
    path: ~/Obsidian/CongTyA          # vault Obsidian thật
  - id: cong-ty-a-sop
    name: Công ty A — Quy trình
    path: ~/Drive/CongTyA/SOP
  - id: cong-ty-b
    name: Công ty B — Thương mại
    path: ~/Obsidian/CongTyB
```

- Mỗi thư mục là một "nguồn" độc lập. Một người nhiều công ty thì khai nhiều thư mục.
- **Quyền theo thư mục:** agent bán hàng của Công ty A chỉ được cấp `cong-ty-a`, nên không đọc được ghi chú của Công ty B.
- Toàn bộ file `.md` được lập chỉ mục FTS5 có bỏ dấu tiếng Việt (gõ "khach hang" vẫn ra "khách hàng"). Việc lập chỉ mục chạy khi khởi động, khi bấm nút, và 15 phút một lần (chỉ đọc lại file đã đổi).
- **Giao diện:** cây thư mục, tìm kiếm, xem ghi chú. Bộ lọc thư mục ở trên giúp xem riêng từng công ty.

---

## 4. Tầng Agent

```yaml
# agents/sales-a/agent.yaml
name: Sale Công ty A
description: Trả lời khách Zalo và Gmail của Công ty A
runtime: claude                 # claude | codex | grok | hermes | mock
model: claude-haiku-4-5         # tuỳ chọn
runtime_options: {}
permission: safe                # safe | full
context: lean                   # standard (mặc định) | lean (rẻ, nhanh: dùng cho trả lời khách)
reports_to: main
can_delegate: false
max_concurrent: 2
budget_usd_month: 30
enabled: true

access:
  brain:
    cong-ty-a:     { read: ["**"], write: [] }
    cong-ty-a-sop: { read: ["Ban-hang/**"] }
  memory: { team: true, private: true }
  skills: [tra-loi-khach, bao-gia]          # hoặc: all
  connections:
    github: ["search_*"]                    # MCP: chỉ các tool khớp mẫu
  modules:                                  # quyền dữ liệu do từng module định nghĩa
    care:  [inbox.read, reply.draft]        # đọc hộp thư, chỉ được soạn nháp
    zalo:  [messages.read]
```

- **Registry:** một schema zod duy nhất; tạo và sửa qua UI rồi ghi lại vào file yaml; bỏ qua thư mục bắt đầu bằng `_`.
- **Agent `main`** là người điều phối: việc chưa có người làm thì giao cho `main`.
- **Agent mẫu của module:** khi Add một module, giao diện hỏi có tạo agent mẫu của module đó không (ví dụ `zalo-care`). Agent mẫu được chép vào `agents/` để bạn sửa tiếp.

---

## 5. Kiểm soát truy cập (`src/access/`)

### 5.1 Tài nguyên được kiểm soát

| Tài nguyên | Khai báo ở đâu | Cấp cho agent |
|---|---|---|
| Thư mục Second Brain | `config/brain.yaml` | `read` / `write` theo mẫu glob |
| Bộ nhớ | DB | đội / riêng |
| MCP server | `config/connections.yaml` (`type: mcp`) | server nào, tool nào |
| Khoá API | `connections.yaml` (`type: env`) | có nhận biến môi trường đó khi chạy không |
| Composio | `connections.yaml` (`type: composio`) | **chỉ module dùng** (Ads, Marketing, Gmail); agent không gọi Composio trực tiếp |
| Skill | `skills/` và skill của module | danh sách id, hoặc `all` |
| **Dữ liệu module** | `module.json` của module khai báo các **scope** | ví dụ `care: [inbox.read, reply.draft]`, `marketing: [comments.reply]` |
| Mức quyền | `permission` | `safe` / `full` |

### 5.2 Luồng tính quyền

```
resolveAccess(agent, task) → EffectiveAccess {
  readDirs[], writeDirs[], memory, mcpServers[{…, allowedTools}], envVars{},
  skills[], moduleScopes{ care: [...], zalo: [...] }, permission
}
```

- Engine tính EffectiveAccess trước mỗi lượt chạy và ghi vào `runs.access_json` cùng `audit_log`.
- Context builder chỉ đưa vào prompt những gì nằm trong quyền.
- Module hỏi `ctx.access.can(agentId, 'care', 'reply.send')` trước mọi hành động thay agent.
- Adapter dịch EffectiveAccess thành cờ của CLI.

### 5.3 Mức chặn thực tế của từng CLI

Đã **kiểm thật ngày 24/10/2026**. Chi tiết và lệnh kiểm lại nằm ở `docs/dev/runtime-verification.md`. Bảng dưới áp dụng cho chế độ `safe`:

| | Ngữ cảnh / module | MCP | Đọc file | Ghi file | Shell |
|---|---|---|---|---|---|
| **Claude** | ✅ | ✅ `--strict-mcp-config` + `--allowedTools` | ✅ `--restricted` + `--add-dir` | ✅ | ✅ bỏ Bash |
| **Codex** | ✅ | ✅ `--ignore-user-config --disable apps --disable plugins` + `enabled_tools` | ❌ không chặn | ✅ sandbox | ⚠️ sandbox chặn ghi nhưng vẫn đọc được |
| **Grok** | ✅ | ⚠️ chặn được server, lọc theo tool chỉ là mềm | ✅ sandbox `strict` (⚠️ khi agent có MCP thì phải dùng `workspace`, khi đó đọc được mọi nơi) | ✅ | ✅ |
| **Hermes** | ✅ | ⚠️ Hermes tự nạp MCP trong cấu hình riêng của nó, cần `HERMES_HOME` hoặc profile riêng | ❌ | ❌ | ⚠️ chế độ CLI `-t file,web,todo` tắt được shell; qua ACP thì không |

✅ chặn cứng · ⚠️ chặn một phần · ❌ không chặn

**Đã chốt sau khi kiểm thật:**
- **Dữ liệu module, bộ nhớ và Second Brain đưa vào prompt luôn được chặn cứng ở mọi runtime**, vì AIOS là bên quyết định đưa gì vào prompt.
- **Thư mục nhạy cảm chỉ cấp cho agent chạy Claude, hoặc Grok không có MCP.** Codex và Hermes đọc được file ngoài thư mục, nên tab Quyền hiện nhãn đỏ "Không chặn" ở dòng "Đọc file" của hai runtime này.
- **Hermes trong chế độ `safe`** chạy qua CLI với `-t file,web,todo` (không có shell). Mỗi agent Hermes nên có `HERMES_HOME` riêng (`runtime_options.home`), để không nạp MCP cá nhân.
- Muốn cách ly tuyệt đối thì chạy agent trong container (bài mở rộng).

### 5.3b Integrations (Pancake, Botcake, Composio…)

Ngoài MCP và khoá API trong `connections.yaml`, lõi có sẵn **danh mục integration** (code ở `src/integrations/`), mang từ bản gốc sang:
- **Danh mục:** Pancake (POS và chat), Botcake, Composio + Google, Pexels, Freesound, ElevenLabs, FPT.AI.
- **Kết nối:** chủ nhập key ở **Kết nối → Integrations**. Key chỉ được lưu khi bài kiểm tra đạt, và được mã hoá.
- **Quyền theo agent:** `access.integrations.<id>`, gồm `read` / `ask` / `write`, hoặc dạng có `ask`/`allow` cho từng lệnh. Lệnh *destructive* luôn phải duyệt.
- **Cách agent gọi:** qua MCP server dựng sẵn `aios-integrations` (`src/integrations/mcp-bridge/`). Mỗi lệnh được phép là một tool. Server gọi về `POST /api/integrations/call` bằng token theo lượt chạy, nên khoá không bao giờ tới tiến trình của agent.
- **Duyệt:** ở mức `ask`, lệnh ghi tạo một mục "Cần bạn". Chủ duyệt thì lệnh chạy và kết quả được ghi thành bình luận của việc; việc chạy lại để agent đọc kết quả.
- **Nhật ký:** mọi lệnh được ghi ở `integration_calls`. Mỗi integration có giới hạn 600 lệnh mỗi giờ.

### 5.4 Nhật ký truy cập

`audit_log` ghi mỗi thay đổi quyền, mỗi lượt chạy (kèm bản chụp quyền), và mỗi hành động module làm thay agent (ví dụ "agent sales-a gửi tin Zalo cho khách X"). Mỗi dòng có `run_id`. Các lần gọi công cụ (kể cả MCP) trong một lượt chạy được ghi thành sự kiện `tool` ở `run_events` của Run đó, không phải ở `audit_log`.

---

## 6. Tầng Runtime

### 6.1 Interface

```ts
interface Runtime {
  id: 'claude' | 'codex' | 'grok' | 'hermes' | 'mock';
  capabilities: { resume: boolean; systemPrompt: 'native' | 'inline'; reportsCost: boolean;
                  enforces: AccessEnforcement; noTools: boolean /* chạy được chế độ không công cụ cho lượt lean */ };
  doctor(): Promise<DoctorReport>;   // có CLI không, phiên bản, đăng nhập, thử "hello"
  run(req: RunRequest): Promise<RunResult>;
}
// RunRequest: agent, access, prompt, systemPrompt, cwd, sessionId?, tools: 'default' | 'none', signal, timeoutMs, onEvent
// RunResult: ok, output, sessionId?, clearSession?, error{family, message, retryAfter?}, usage{…} (thiếu = "không rõ")
```

### 6.2 Cách gọi từng CLI

| Runtime | Lệnh | System prompt | Nối phiên | Kết quả |
|---|---|---|---|---|
| Claude | `claude -p --output-format stream-json --verbose`, prompt qua stdin | `--append-system-prompt-file` (phiên mới) | `--resume` | `result`: `total_cost_usd`, `modelUsage` |
| Codex | `codex exec --json --skip-git-repo-check -C <cwd> -` | ghép vào prompt (phiên mới) | `codex exec resume <id> -` | `thread.started`, `item.completed`, `turn.completed`; không có chi phí |
| Grok | `grok --prompt-file <file> --output-format streaming-json --cwd` | `--rules "<nội dung>"` (Grok không đọc `@file`; nội dung quá 100 KB thì ghép vào file prompt) | `--resume` | `text`, `end` (`usage`, `total_cost_usd`) |
| Hermes | `hermes [-p profile] acp` (JSON-RPC); nếu ACP không ổn định thì dùng `hermes chat -q` | ghép vào prompt (phiên mới) | `session/load` (ACP) hoặc `--resume` (chế độ `cli`) | ACP: `usage` trong `session/prompt`; `cli`: câu trả lời ở stdout, `session_id` ở stderr |
| mock | kịch bản giả lập | — | có | 0 |

**Bộ chạy dùng chung `runtimes/process.ts`:**
- Không qua shell; tách nhóm tiến trình. Khi hết giờ: SIGTERM, chờ, rồi SIGKILL.
- Giới hạn bộ đệm; đọc JSON từng dòng.
- **Xoá biến `CLAUDECODE` và `CLAUDE_CODE_*`** trước khi gọi CLI.
- Lọc biến môi trường; che khoá bí mật trong nhật ký.

**Các bẫy đã biết (học từ Paperclip):**
- Claude từ chối mà vẫn exit 0.
- Không dùng `dontAsk` cho Grok.
- `input_tokens` của Codex đã gồm token cache.
- Nối phiên lỗi thì mở phiên mới một lần.
- Khi nối phiên, chỉ gửi tin mới.

---

## 7. Tầng Giao việc

Giữ như bản 2, bỏ phần không gian.

**Trạng thái Task:** `queued` → `running` → `done` | `review` | `failed` | `waiting` (chờ việc con) | `cancelled`.

**Quy tắc "không việc nào bị bỏ quên":** khởi động lại thì đưa việc đang chạy dở về hàng đợi **một lần**; lần sau chuyển `failed` và hiện ở "Cần bạn".

**Trường của Task:**
- `source`: `user` | `api` | `chat` | `schedule:<id>` | `agent:<id>` | `module:<id>`
- `trigger`: lý do agent được gọi, ghi vào đầu prompt
- `context_profile`: `standard` | `lean`
- `meta`: dữ liệu riêng của module (ví dụ id cuộc hội thoại với khách)

**Các phần khác:**
- **Bình luận trên việc:** góp ý vào một việc thì việc đó chạy lại với trigger `commented`.
- **Dispatcher:** nhận việc nguyên tử; tôn trọng `max_concurrent` của agent và giới hạn toàn hệ thống. Việc từ module (ví dụ trả lời khách) có ưu tiên cao.
- **Engine** làm theo thứ tự:
  1. Kiểm tra agent đang bật và còn ngân sách.
  2. Tính quyền.
  3. Gom ngữ cảnh.
  4. Chạy runtime.
  5. Đọc chỉ thị ở câu trả lời cuối.
  6. Ghi sổ.
  7. Gọi hook `onTaskFinished` của module đã tạo Task.
- **Chỉ thị:** `<aios-task to=…>`, `<aios-memory scope=…>`, `<aios-status>review</aios-status>`, và `<aios-action module=… name=…>{json}</aios-action>` để gọi hành động của module (xem §9.2). Hành động chỉ chạy khi agent được cấp đúng scope của module; kết quả ghi vào bình luận của việc và nhật ký. Mỗi chỉ thị đều được kiểm tra: agent nhận có thật và đang bật; agent gửi có `can_delegate`; giới hạn độ sâu 3, tối đa 5 việc con, tối đa 3 vòng.
- **Hỏi cả nhóm và relay:** Task cha `kind: team`.
- **Lịch:** `skip_if_active`, `skip_missed`, có múi giờ.
- **Chat:** mỗi tin là một Task `kind: chat`.

### 7.1 Hai mức ngữ cảnh

| | `standard` (việc thường, chat) | `lean` (việc do module tạo, ví dụ trả lời khách) |
|---|---|---|
| Persona | ✅ | ✅ |
| Danh sách đội và cách dùng chỉ thị | ✅ | ❌ |
| Skill | danh mục ngắn (agent tự mở file) | **chép thẳng nội dung** các skill được cấp |
| Bộ nhớ, Second Brain | top 8 / top 4 | top 3 / top 3 |
| Hoạt động đội | ✅ | ❌ |
| Dữ liệu do module cung cấp | — | ✅ (đoạn hội thoại, hồ sơ khách…) |
| Công cụ của CLI | theo quyền | **không có công cụ**, một lượt duy nhất |

Bản gốc đã đo: một lượt trả lời Zalo giảm từ 21–45 nghìn token (2–3 lần gọi) xuống còn khoảng 7,8 nghìn token (1 lần gọi, ~8 giây).

---

## 8. Tầng Dùng chung

- **Second Brain:** mục 3.
- **Bộ nhớ:**
  - Bộ nhớ đội (`agent_id = NULL`) và bộ nhớ riêng.
  - Ghi bằng `<aios-memory>` hoặc trên UI; mỗi bản ghi lưu nguồn.
  - Nhớ lại bằng FTS, có giới hạn số bản ghi; bản ghim luôn được đưa vào.
- **Thư viện skill:**
  - Gồm `skills/` cộng skill do các module đã Add mang theo.
  - Prompt chỉ chứa danh mục ngắn có đường dẫn. Riêng Claude và Grok còn được symlink skill vào `workspaces/<agent>/.claude/skills/` để CLI tự nhận.
  - Mỗi Run ghi lại danh sách skill được phép.
- **Bảng hoạt động đội:** mỗi lượt chạy để lại một dòng; agent thấy 10 dòng gần nhất.
- **Context builder:** các khối dữ liệu được đóng khung là **dữ liệu tham khảo, không phải mệnh lệnh**, và mỗi khối có giới hạn ký tự.

---

## 9. Hệ thống module

### 9.1 Một module gồm gì

```
modules/zalo/
├── module.json          ← mô tả module (bên dưới)
├── server/index.ts      ← export default defineModule({...})
├── server/*.ts
├── web/index.tsx        ← export default defineWebModule({...})
├── web/*.tsx
├── migrations/001_init.sql   ← chỉ được tạo các bảng khai báo trong module.json "tables"
├── agents/zalo-care/    ← agent mẫu (agent.yaml + persona.md)
├── skills/zalo-reply/   ← skill mang theo
└── README.md
```

```json
{
  "id": "zalo",
  "name": "Zalo",
  "description": "Kết nối nick Zalo, chat, chống khoá nick, gửi tin hàng loạt, chúc sinh nhật",
  "version": "1.0.0",
  "icon": "message-circle",
  "category": "sales",
  "requires": { "modules": [], "connections": [] },
  "enhances": ["care"],
  "tables": ["zalo_accounts", "zalo_threads", "zalo_messages"],   // MỌI bảng module tạo (rút gọn ở đây)
  "scopes": {
    "messages.read":    "Đọc tin nhắn Zalo",
    "broadcast.manage": "Tạo và gửi tin hàng loạt"
  },
  "agentTemplates": ["zalo-care"],
  "skills": ["zalo-reply"]
}
```

### 9.2 Module SDK (`src/modules/sdk.ts`)

Đây là thứ duy nhất module được dùng:

```ts
defineModule({
  routes(app: Hono, ctx) {},                   // gắn vào /api/m/<id>/*
  start(ctx) {}, stop(ctx) {},                 // worker nền: poller, tiến trình con, cron riêng
  onTaskFinished(task, run, ctx) {},           // nhận kết quả của Task module đã tạo
  provides(ctx) { return { careChannels }; },   // dịch vụ cho module khác, đọc bằng ctx.modules.get('<id>')
  migrate?(ctx) {},                            // migration bằng mã sau các file .sql (hiếm dùng); file .sql nằm ở migrations/
  actions: { 'content.add': { scope: 'content.write', description, example, handler } },  // agent gọi bằng <aios-action>
  agentContext({ agent, task, scopes }, ctx): string,  // dữ liệu ngắn của module, thêm vào MỌI lượt chạy của agent có scope module này
  contextFor?(task, ctx): string,              // dữ liệu module đưa vào lượt lean (đã lọc theo quyền)
})

ctx = {
  db,                      // chỉ được đụng bảng có tiền tố của mình
  tasks:   { create({ agentId, title, prompt, contextProfile, trigger, meta, priority }), get, cancel },
  agents:  { list, get, runLean({ agentId, title, prompt, moduleContext, images, timeoutMs, ... }) },  // lượt lean, chờ kết quả
  access:  { can(agentId, scope), canIn(moduleId, agentId, scope) },
  connections: { composio(), secret(name), has(idOrType) },
  memory:  { add, recall },  brain: { search },
  settings:{ get, set, all },   // cài đặt riêng của module (JSON, kiểu secret được mã hoá)
  schedule:{ every(name, mốc, fn) },   // mốc = mili giây hoặc biểu thức cron; tự dừng khi Remove
  events:  { emit, on },     // tên tự gắn tiền tố "<id>:"
  audit, attention, outbound, crypto, log, dataDir,
  modules: { get(id), isEnabled(id) },   // lấy "provides" của module khác (ví dụ zalo lấy careChannels từ care)
}
```

```ts
defineWebModule({
  nav:     [{ group: 'sales', label: 'Zalo', path: '/m/zalo', icon }],
  routes:  [{ path: '/m/zalo/accounts', component: ZaloAccounts }],
  widgets: [
    { slot: 'overview', id: 'zalo-overview', title: 'Bán hàng qua Zalo', order: 30, component: ZaloOverview },  // khối số liệu trên Tổng quan, nhận { range }
    { slot: 'dashboard', id: 'zalo-status', component: ZaloStatusCard },  // thẻ nhỏ ở mục Theo dõi nhanh
  ],
  agentAccess: [{ scope: 'messages.read', label: 'Đọc tin Zalo' }],  // hiện ở tab Quyền của agent
})
```

### 9.3 Bấm Add: vòng đời của module

```
Trang "Module": danh sách module trong modules/  →  [Add]
  1. Kiểm tra điều kiện: module phụ thuộc đã Add chưa, kết nối cần có chưa (ví dụ khoá Composio)
     → thiếu thì hiện hướng dẫn và nút đi tới Kết nối
  2. Chạy migrations (chỉ được tạo các bảng khai báo trong "tables"; Purge xoá đúng các bảng này)
  3. Hỏi có tạo agent mẫu và chép skill không (có ô tick)
  4. Bật module: routes /api/m/<id> mở, worker start(), menu và widget hiện ngay (không cần khởi động lại)
[Remove]  → tắt: stop(), ẩn menu, ĐỂ NGUYÊN dữ liệu
[Xoá dữ liệu] → cần gõ lại tên module để xác nhận; xoá các bảng của module
```

**Cách hiện thực:**
- Phần server của mọi module trong `modules/` được nạp khi khởi động, nhưng chỉ module đã Add mới được bật.
- Middleware trả 404 cho route của module chưa Add.
- Phần web của mọi module được Vite đóng gói sẵn (`import.meta.glob`). Giao diện hỏi `/api/modules` để biết module nào đang bật.
- Bảng `modules` (id, enabled, version, installed_at, settings) lưu trạng thái.

**Học viên làm module mới:** `npm run aios -- module new ten-module` tạo khung từ `modules/_template/`.

### 9.4 Module giao việc cho agent như thế nào

Lấy ví dụ trả lời tin Zalo:

```
tin Zalo đến ─► zalo (kênh) ─► care: lưu hội thoại, áp quy tắc
                                │ chế độ AI = draft/auto, agent được gán có scope reply.*
                                ▼
                 ctx.tasks.create({ agentId: 'sales-a', contextProfile: 'lean',
                                    trigger: 'care.message', meta: { conversationId } })
                                │  (Engine: quyền + ngữ cảnh lean + contextFor() của care)
                                ▼
                 onTaskFinished → output là câu trả lời
                                ├─ draft: vào "Nháp chờ duyệt"
                                └─ auto (có reply.send): chờ vài giây (bấm Huỷ được) → zalo.send()
                                   giờ nghỉ, từ khoá cần duyệt, hoặc <aios-status>review → về nháp
```

Lượt trả lời khách cũng là Task. Nó hiện ở trang Công việc (mặc định lọc theo nguồn), có tính chi phí, có nhật ký, và đi qua đúng một cổng chạy như mọi việc khác.

---

## 10. Tầng App

**Menu:**

| Nhóm | Mục |
|---|---|
| Lõi | Tổng quan (Cần bạn, widget của các module) · Agents · Công việc · Lịch · Trò chuyện · Second Brain · Bộ nhớ · Skills |
| Sales (module) | Hộp thư · Nháp chờ duyệt · Khách hàng · Việc chăm sóc · Zalo · Gmail |
| Marketing (module) | Nội dung Facebook · Lịch đăng · Bình luận AI · Phân tích · Quảng cáo |
| Hệ thống | Module · Kết nối · Nhật ký truy cập · Cài đặt (doctor của 4 CLI) |

**API lõi:**
- health, runtimes, stats, attention
- agents (kèm `/access` để xem trước quyền)
- connections, tasks (kèm comments và team), runs, schedules, conversations
- brain, memory, skills, board, audit
- modules: `GET /api/modules`, `POST /api/modules/:id/add`, `…/remove`, `…/purge`
- SSE `/api/events`

API của từng module nằm dưới `/api/m/<id>/*`.

---

## 11. Dữ liệu

**Agent, thư mục Second Brain và kết nối là file yaml**, không nằm trong DB.

**Bảng của lõi:**
- `tasks` (source, trigger, context_profile, meta…)
- `task_comments`, `runs` (access_json, skills_json…), `run_events`
- `schedules`, `conversations`, `messages`
- `memories` (+ fts), `brain_docs` (+ fts)
- `board`, `audit_log`, `attention`, `kv`
- `modules`, `schema_migrations` (migration đã chạy, theo cặp chủ sở hữu và id)

**Bảng của module** được khai báo trong `module.json` (`tables`):
- Module copy từ bản gốc **giữ tên bảng cũ** (`care_*`, `zalo_*`, `email_*`, `fb_*`) để khỏi phải sửa SQL.
- Module mới nên dùng id của module làm tiền tố.

---

## 12. An toàn

1. Mặc định không cấp gì. Quyền được tính ở một chỗ, CLI thực thi, mọi thứ được ghi nhật ký. Chỗ nào chặn cứng, chỗ nào chỉ là lời dặn đều được nói rõ.
2. Dữ liệu không phải mệnh lệnh. Chỉ thị chỉ được đọc ở câu trả lời cuối và phải qua kiểm tra.
3. Khoá bí mật nằm trong `.env`; chỉ tới tiến trình con được cấp, hoặc chỉ module dùng (Composio); bị che trong nhật ký.
4. Hành động ra ngoài (gửi Zalo, email, đăng Facebook) **mặc định là nháp**. Muốn tự gửi thì phải cấp scope `*.send`, và vẫn có giờ nghỉ, giới hạn và nút Huỷ.
5. API chỉ nghe trên `127.0.0.1`, có `AIOS_TOKEN`. Có ngân sách theo agent và giới hạn thời gian mỗi lượt.

---

## 13. Học từ Paperclip (tóm tắt)

**Lấy:**
- Interface adapter tối giản (`run` + `doctor`), nhóm lỗi, `clearSession`, thiếu chi phí thì ghi "không rõ".
- Bộ chạy tiến trình con dùng chung.
- Nhận việc nguyên tử; quy tắc "không việc nào bị bỏ quên".
- Lý do được gọi (trigger) ghi vào prompt.
- Giao việc bằng một việc tự đủ thông tin; nhắc tên không đánh thức ai.
- Lịch `skip_if_active`; bình luận và trạng thái `review`.
- Danh mục skill ngắn trong prompt; `audit_log` có `run_id`.
- Các bẫy của từng CLI.

**Không lấy:** Postgres, plugin runtime, native runner, JWT cho agent, approvals đầy đủ, công ty như một tenant.

---

## 14. Mang module từ bản gốc sang: quy tắc copy

Chi tiết nằm ở [dev/BUILD-PLAN.md](dev/BUILD-PLAN.md) §0. Tóm tắt:

- **Copy nguyên code đã chạy**, kèm cả test, cho mọi file **chỉ có trong bản của bạn** (fork `freedom_os`, không có ở upstream ClaudeClaw). Cách làm là copy hết rồi xoá phần thừa.
  - Căn cứ: `LICENSE.md` §8.2 cho bạn sở hữu code bạn tự viết.
- **Không copy file có từ upstream ClaudeClaw** (`db.ts`, logger, agent-engine, PageHeader…). Những file này được viết lại, giữ nguyên tên hàm và props, để code đã copy chạy được mà không phải sửa nhiều.
  - Căn cứ: §1.1 và §5 cấm đưa code đó cho người không phải thành viên.
- Có **script kiểm tra nguồn gốc**: báo lỗi nếu bất kỳ file nào trong AIOS-Lite trùng một đoạn dài với code upstream ClaudeClaw.
- **Zalo:** 12 file có gốc ZaloCRM được **copy nguyên** (danh sách chính xác ở `modules/zalo/NOTICE`). Vì vậy **riêng module `zalo` mang license AGPL-3.0** (có file LICENSE và NOTICE riêng). Lõi và các module khác không bị ảnh hưởng.
  - Ai phát hành bản có module Zalo thì phải kèm mã nguồn của module đó.
- **Paperclip (MIT):** copy được, ghi công trong `THIRD_PARTY_NOTICES.md`.
- **Thư viện:** `@composio/core` (ISC) và `zca-js` (MIT).

(Mình không phải luật sư. Nếu cần chắc chắn trước khi phát cho học viên, hỏi Prompt Advisers về §8.2.)

---

## 15. Kế hoạch build

**Giai đoạn 1: Lõi, Module SDK, trang Module và `_template`**

Năm agent Sonnet chạy song song, mỗi agent sở hữu một phần:
1. `runtimes/` (kiểm tra thật với 4 CLI)
2. `agents/` + `access/` + `shared/`
3. `work/` + `main.ts`
4. `modules/` (SDK, loader, lifecycle) + `api/` + `cli/`
5. `web/` (lõi và module-host)

Mình ghép lại, chạy toàn bộ test, chạy thử đầu cuối với `mock`, chạy một việc thật qua mỗi CLI, và thử chặn quyền theo thư mục.

**Giai đoạn 2: Năm module**

Năm agent Sonnet song song: `care` · `zalo` · `gmail` · `marketing` · `ads`. Mỗi agent đọc tài liệu và phần code bạn tự viết ở bản gốc (theo quy tắc mục 14) rồi viết lại trên SDK.

**Kiểm thử giai đoạn 2:**
- Test có kết nối giả lập; chạy thử đầu cuối với `mock`.
- **Thử thật chỉ khi bạn cho phép:** khoá Composio; Page thử "Ninh Bình Home"; một nick Zalo thử, không gửi cho khách thật.

**Sau cùng:** tài liệu dạy học, viết theo đúng code đã chạy.

**Còn chờ bạn:** license của template (MIT hay license riêng). Việc này không chặn build.
