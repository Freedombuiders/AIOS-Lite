# AIOS-Lite — Kế hoạch build chi tiết

> 24/10/2026. Đi kèm [../ARCHITECTURE.md](../ARCHITECTURE.md) và [../MODULES.md](../MODULES.md).
> Bản gốc: `~/Developer/GitHub/claudeclaw-os`, gọi tắt là **GỐC**. Upstream ClaudeClaw: remote `upstream/main` (de190cf).

---

## 0. Quy tắc copy (đã quyết)

### 0.1 Phân loại mọi file nguồn

| Loại | Điều kiện | Cách làm |
|---|---|---|
| **A. Copy nguyên** | File **không có ở `upstream/main`** (do bạn hoặc đội bạn viết) và không import lõi ClaudeClaw | Copy, chỉ đổi đường dẫn |
| **B. Copy rồi nối lại** | File không có ở upstream, nhưng import lõi ClaudeClaw (`db`, `logger`, `agent-engine`…) | Copy, rồi thay import bằng Module SDK hoặc lớp compat |
| **C. Viết lại, giữ nguyên giao diện** | File **có ở upstream** mà code loại A/B cần dùng (ví dụ `PageHeader`, `useFetch`, `sanitizeOutboundText`) | Viết mới, giữ tên hàm, props và kiểu trả về để code đã copy không phải sửa |
| **D. Copy theo AGPL** | 15 file Zalo có gốc ZaloCRM | Copy vào `modules/zalo/`; module này mang license AGPL-3.0, có NOTICE liệt kê từng file |
| **E. Copy có ghi công** | Paperclip (MIT) | Copy, ghi vào `THIRD_PARTY_NOTICES.md` |
| **F. Bỏ** | Phần không dùng trong AIOS-Lite (mục 5) | Không copy, hoặc copy rồi xoá |

**Cách làm với module: copy hết rồi xoá.**
1. Copy cả thư mục module, **kèm test**, cùng các đoạn SQL của module nằm trong `db.ts` (giữa các dấu `@zalo-*`, `@fbstudio-*`, `@email-*`).
2. Xoá các phần loại F.
3. Nối lại import (loại B và C).
4. Sửa cho test đã copy chạy xanh. Test là lưới an toàn để biết code copy sang vẫn đúng.

### 0.2 Kết quả quét GỐC (24/10)

| Phần | File (không tính test) | Dòng | Test | Không import gì ngoài module | Ghi chú |
|---|---|---|---|---|---|
| `src/customer-care` | 203 | 50.387 | 135 | 182 | Tách lớp tốt; chỉ ~20 chỗ import lõi |
| `src/zalo` | 38 | 10.106 | 34 | 9 | 15 file có gốc ZaloCRM (loại D) |
| `src/fbstudio` | 62 | 12.101 | 40 | 18 | Import `db` 43 lần (SQL nằm trong `db.ts`) |
| `src/email` | 16 | 3.512 | 17 | 1 | |
| Web (fb, care, email, zalo, marketing) | ~100 | ~14.500 | — | phần lớn | Stack: **Preact + wouter-preact + Tailwind 4 + lucide-preact**, đường dẫn alias `@/` |

**File upstream mà code copy cần dùng (loại C, phải viết lại):**
- **Backend:** `db` (helper), `logger`, `config`, `kill-switches`, `env`, `env-write`, `platform`, `crash-guard`, `outbound-sanitizer`, `outbound-policy`, `security`, `agent-config`, `provider*`, `active-provider`, `agent-engine/*`.
- **Web:** `PageHeader`, `PageState`, `Toggle`, `ConfirmModal`, `Pill`, `Modal`, `toasts`, `useFetch`, `api`, `useDebounce`, `format`, `personalization`. Tổng khoảng 1.000 dòng.

**File của bạn ở lõi GỐC, copy được (loại A/B):** `composio-credentials`, `fbstudio/composio`, `agent-context` (context lean), `skill-commands`, `agent-skill-policy`, `vault-mentions`, `owner-alert-prefs`, `budgets/engine-hook`, `integrations/*`, `agent-data-access`. Ở web: `page-context`, `ChatThread`, `RichTextEditor`, `MentionInput`, `FolderPicker`, `BrandIcons`, `chat-dock`.

**Skill copy được:** `fb-content`, `fb-comment-reply`, `kol-studio`, `video-*`, `reflection-coach`. Các skill `gmail`, `obsidian`, `slack`… là của upstream nên không copy.

### 0.3 Lưới chặn nhầm license

- `scripts/check-provenance.mjs` lấy toàn bộ file của `upstream/main`, chuẩn hoá từng dòng (bỏ khoảng trắng, bỏ dòng ngắn), rồi tìm trong AIOS-Lite **đoạn nào có từ 8 dòng liên tiếp trùng code upstream**.
- Có thì báo lỗi. Script chạy trong `npm test`.
- Script cũng kiểm tra không file nào ngoài `modules/zalo/` chứa chữ "ZaloCRM".

---

## 1. Đổi stack (để copy được UI)

| | Trước (bản nháp) | Chốt | Lý do |
|---|---|---|---|
| Web | React 19 | **Preact 10 + wouter-preact + Tailwind 4 + lucide-preact**, alias `@/` | Trùng GỐC, nên copy được khoảng 14.500 dòng UI |
| TypeScript / Vite / Vitest | 7 / 8 / 5 | **TS 5.9 / Vite 6 / Vitest 3** | Code và test GỐC viết cho TS 5.7 / Vitest 2. Giảm rủi ro khi copy |
| Logger | — | **pino 9** | Module GỐC dùng pino |
| Thêm | — | `zca-js@2.1.2`, `@composio/core@^0.22`, `image-size@2.0.2`, `cron-parser@^5` | Thư viện module GỐC đang dùng |

---

## 2. Các giai đoạn

```
P0 (mình)      khung · hợp đồng · lớp compat · công cụ copy · manifest      ─┐
P1 (5 agent)   lõi: runtimes │ agents+access+shared │ work │ modules+api+cli │ web lõi ─┤
                                                     ↓ cổng P1 (mình kiểm)        │
P2 (5 agent)   module: care │ zalo │ gmail │ marketing │ ads                       │
                                                     ↓ cổng P2 (mình kiểm)        │
P3 (mình)      ghép · e2e · thử thật (khi bạn cho phép) · tài liệu dạy học       ─┘
```

**Quy tắc chung cho mọi agent:**
- Chỉ sửa file mình sở hữu.
- Chỉ dùng hợp đồng trong `src/**/contracts.ts` và `docs/dev/API.md`.
- Không chạy `npm install`. Thiếu thư viện thì ghi vào báo cáo.
- Không đọc thư mục upstream-only của GỐC, ngoài phần được giao.
- Mỗi agent tự chạy test **phần của mình** trước khi báo xong. Mình chạy toàn bộ một lần ở cuối mỗi giai đoạn.
- Báo cáo cuối gồm: file đã tạo, file đã copy (loại A/B/D), file đã xoá kèm lý do, test, và những gì chưa xong.

---

## 3. P0: Mình làm (nền cho 10 agent)

| ID | Việc | Kết quả | Xong khi |
|---|---|---|---|
| P0.1 | Đổi dependencies theo mục 1; gỡ React; cấu hình Vite với Preact, Tailwind 4 và alias `@/`; tsconfig server và web | `package.json`, `vite.config.ts`, `web/tsconfig.json`, `web/index.html` | `npm run typecheck` chạy trên khung rỗng |
| P0.2 | `src/core/`: types, config, db (chạy migration, schema lõi đầy đủ), events, redact, crypto (AES-GCM), env | 7 file | Test db và migration xanh |
| P0.3 | Hợp đồng: `runtimes/contracts.ts`, `access/contracts.ts`, `work/contracts.ts`, `shared/contracts.ts`, `modules/sdk.ts` (chỉ kiểu), `web/src/module-host/contracts.ts`, `docs/dev/API.md` | Hàm và kiểu cố định | Agent chỉ cần đọc các file này là code được |
| P0.4 | **Danh sách compat:** quét mọi import loại C của code sẽ copy, liệt kê **từng symbol đang dùng** (ví dụ `logger.info`, `sanitizeOutboundText(text, opts)`, `isKillSwitchOn('ZALO_AUTOREPLY_ENABLED')`) | `docs/dev/port/compat-symbols.md` cùng file chữ ký `src/modules/compat/index.ts` (stub) | Mỗi symbol có chữ ký và chỗ thay thế trong AIOS-Lite |
| P0.5 | Công cụ: `scripts/port/copy.mjs` (copy theo manifest, **từ chối file có ở upstream**, ghi `PORTING.md`), `scripts/port/extract-db-sections.mjs` (tách SQL theo dấu `@…` trong `db.ts` → `migrations/*.sql` và `store.ts`), `scripts/check-provenance.mjs` | 3 script | Chạy thử trên `src/email` ra đúng file |
| P0.6 | **Manifest cho từng module** (giữ / chuyển / bỏ đến từng file), sinh tự động rồi mình duyệt tay | `docs/dev/port/{care,zalo,gmail,marketing,ads,core-web}.md` | Mọi file của GỐC trong phạm vi đều được xếp loại |
| P0.7 | Brief cho agent | `docs/dev/BRIEF.md` | — |

---

## 4. P1: Lõi (5 agent Sonnet song song)

### P1-A · Runtimes (`src/runtimes/`)

**Copy:**
- Paperclip `runChildProcess` (loại E) → `process.ts`.
- Bộ parser JSONL kiểu Paperclip → `jsonl.ts`.
- Mẫu che khoá bí mật → `core/redact.ts` (bổ sung).

**Viết:**
- `claude.ts`, `codex.ts`, `grok.ts`, `hermes.ts` + `acp.ts`, `mock.ts`, `index.ts`.
- `doctor()` cho từng runtime.
- **Hàm dịch EffectiveAccess → cờ CLI** (mục 5.3 của ARCHITECTURE).
- Chế độ `tools: 'none'` cho lượt lean.
- Thử lại với phiên mới khi nối phiên lỗi.
- Phân loại lỗi (`family`).

**Test:** có CLI giả (script in JSONL mẫu lấy từ fixture của Paperclip và từ lần chạy thật).

**Kiểm thật**, với prompt nhỏ:
1. 4 CLI trả lời "hello".
2. Claude với `--restricted` không đọc được file ngoài `--add-dir`.
3. Codex với `--ignore-user-config` không thấy MCP cá nhân.
4. Grok `--sandbox`: chặn được tới đâu.
5. Hermes ACP: `session/new` nhận `mcpServers`.

Kết quả được ghi vào `docs/dev/runtime-verification.md` và cập nhật các ô ⚠️ trong bảng 5.3.

**Xong khi:** test xanh; 4 CLI được kiểm thật; bảng 5.3 hết dấu "kiểm khi build".

### P1-B · Agents, phân quyền, tầng dùng chung (`src/agents/`, `src/access/`, `src/shared/`)

**Copy (loại B):**
- `agent-context.ts`: ý tưởng và code profile lean.
- `agent-skill-policy.ts`, `skill-commands.ts`.
- `integrations/*`: khung cấp quyền kết nối.
- `agent-data-access.ts`: mô hình cấp quyền dữ liệu.
- `composio-credentials.ts` + `fbstudio/composio.ts` → `access/composio.ts`, làm client Composio dùng chung cho module.

**Viết:**
- `agents/schema.ts` (zod, đủ trường mục 4 của ARCHITECTURE) và `registry.ts`.
- `access/policy.ts` (`resolveAccess`), `connections.ts` (mcp / env / composio), `audit.ts`.
- `shared/brain.ts`: nhiều thư mục, FTS bỏ dấu, quét tăng dần.
- `memory.ts`, `skills.ts` (danh mục + symlink `.claude/skills`), `board.ts`.
- `context.ts`: hai profile `standard` và `lean`, mỗi khối có giới hạn ký tự, đóng khung dữ liệu.

**Dữ liệu mẫu:**
- Agent: `main` (Claude), `coder` (Codex), `researcher` (Grok), `assistant` (Hermes), `demo` (mock).
- `config/brain.yaml` có 3 thư mục mẫu; vài skill mẫu.

**Xong khi:** test xanh. Có test chứng minh **agent không được cấp thư mục B thì không có ghi chú B trong prompt**.

### P1-C · Giao việc (`src/work/`, `src/main.ts`)

**Viết:**
- `tasks.ts`, `runs.ts`, `comments.ts`.
- `dispatcher.ts`: nhận việc bằng `UPDATE … RETURNING`, giới hạn theo agent và toàn hệ thống.
- `engine.ts`: 7 bước, gọi hook của module.
- `directives.ts`: chỉ đọc câu trả lời cuối, kiểm tra trước khi áp dụng.
- `team.ts`: song song và relay.
- `scheduler.ts`: `skip_if_active`, `skip_missed`, múi giờ.
- `chat.ts`, `stats.ts`, `attention.ts` (Cần bạn).
- Khôi phục khi khởi động lại.
- `main.ts`: khởi động theo thứ tự db → registry → modules → dispatcher → scheduler → API.

**Xong khi:** test với runtime `mock` phủ đủ:
- giao việc → `waiting` → các việc con xong → tổng hợp;
- relay;
- `review` → bình luận → chạy lại;
- huỷ;
- khôi phục sau khởi động lại;
- vượt ngân sách.

### P1-D · Module runtime, API, CLI (`src/modules/`, `src/api/`, `src/cli/`)

**Viết:**
- `modules/sdk.ts` (phần chạy), `loader.ts`.
- `lifecycle.ts`: add / remove / purge; migration có tiền tố bảng; chép agent mẫu và skill.
- Chặn route của module chưa Add.
- `ctx.agents.runLean()`: tạo Task lean rồi chờ kết quả qua bus, **vẫn đi qua Engine**.
- `ctx.attention.raise()`.
- **`modules/compat/`**: hiện thực các symbol trong danh sách P0.4 (logger, db, kill switch → settings của module, `sanitizeOutboundText`, `readEnvFile` / `setEnvKey`, `isProcessAlive`, `notifyOwner` → attention, mã hoá).
- API theo `docs/dev/API.md`; SSE; `AIOS_TOKEN`.
- CLI `aios`: agents, task, memory, brain, `module new|add|remove`.
- `modules/_template/`.

**Xong khi:**
- test xanh;
- `_template` Add / Remove được mà không cần khởi động lại;
- test hợp đồng API khớp `API.md`.

### P1-E · Web lõi (`web/src/`)

**Viết lại loại C, giữ nguyên props:** `PageHeader`, `PageState`, `Toggle`, `ConfirmModal`, `Pill`, `Modal`, `toasts`, `useFetch`, `api`, `useDebounce`, `format`, `personalization`.

**Copy (loại A):** `page-context`, `ChatThread`, `RichTextEditor`, `MentionInput`, `FolderPicker`, `BrandIcons`, `chat-dock`.

**Viết:**
- Khung app: sidebar với nhóm lõi và nhóm của module.
- Trang: Tổng quan (Cần bạn + widget), Agents (+ tab Quyền, hiện mức cứng/mềm), Công việc (kanban), Chi tiết việc (chữ chạy trực tiếp qua SSE), Lịch, Trò chuyện, Second Brain, Bộ nhớ, Skills, Kết nối, Nhật ký, **Module** (Add/Remove), Cài đặt (doctor).
- `module-host/`:
  - nạp phần web của module bằng `import.meta.glob`;
  - điểm mở rộng web `useProvides('care.channelPanel')`.

**Xong khi:** `vite build` qua; typecheck web sạch; chạy với API giả lập thì mọi trang lõi hiện được.

### Cổng P1 (mình)

1. typecheck + toàn bộ test + `check-provenance`.
2. Chạy thật với `mock`: tạo agent → giao việc → `main` giao việc con → tổng hợp.
3. Một việc thật qua mỗi CLI.
4. Thử chặn quyền theo thư mục.
5. Add / Remove `_template` trên giao diện.

---

## 5. P2: Module (5 agent Sonnet song song)

**Quy trình chung cho mỗi agent:**
1. Chạy `scripts/port/copy.mjs` theo manifest.
2. Chạy `extract-db-sections.mjs`.
3. Xoá phần F.
4. Thay import bằng SDK hoặc `modules/compat`.
5. Viết `module.json`, `server/index.ts` (`defineModule`), `web/index.tsx` (`defineWebModule`).
6. Thêm agent mẫu và skill.
7. Sửa test đã copy cho xanh. Test của phần đã xoá thì xoá theo, và ghi lý do vào `PORTING.md`.
8. Viết `README.md` cho module.

**Lượt agent (trả lời khách, phân tích…):**
- Mọi chỗ GỐC gọi `EngineFactory.forProvider` hoặc `runAgent` đều đổi thành `ctx.agents.runLean(...)`.
- Kiểm quyền bằng `ctx.access.can(agentId, '<module>', '<scope>')`.

### P2-care · `modules/care`

**Giữ (copy):**
- `src/customer-care/{domain, application, persistence, policy, workflow, api, runtime, ops}`, `connectors/contract.ts`, `fake-connector.ts`.
- Web: `pages/care/*`, `components/care/**`, `components/care-channels/{shared, RulesSection, NotifySection, EditorShell, ChannelCards, CannedSection, AdvancedPanel, AddChannelModal}`, `lib/care/**`, `lib/care-channels/**`.

**Chuyển cho module khác:**
- `connectors/zalo/**` → zalo.
- `connectors/email/**` → gmail.
- UI `care-channels/zalo/*` → zalo; `care-channels/email/*` → gmail. Hai module này đăng ký panel vào care qua `care.channelPanel`.

**Bỏ (F):**
- `bridge/`, `legacy-delivery/`, `rehearsal/`, `bench/`.
- `runtime/{cutover*, legacy-compat*, app-bridge*}`.
- `connectors/telegram/`, `connectors/telegram-bot/`.
- `owner-alerts/` (thay bằng `ctx.attention.raise`).
- `api/dto-telegram*`, `dto-bridge`; ở web: `lib/care/telegram*`, `components/care/bridge/**`, `UnbridgedBanner`.

**Nối lại:**
- `application/agent-runner-engine.ts` → `ctx.agents.runLean`.
- `budgets/engine-hook` → bỏ, vì Engine của lõi đã kiểm ngân sách.
- Điểm mở rộng `provides.careChannel` / `ingest` cho zalo và gmail, theo `connectors/contract.ts` giữ nguyên.

**Scope:** `inbox.read`, `customers.read`, `customers.write`, `reply.draft`, `reply.send`.

**Agent mẫu:** `cskh`. **Skill:** `tra-loi-khach` (viết mới từ prompt chăm sóc khách của GỐC).

**Xong khi:**
- test copy xanh;
- e2e với `fake-connector`: tin đến → lượt lean → nháp → duyệt → gửi;
- chế độ tự động có Huỷ;
- giờ nghỉ chuyển thành nháp;
- tiếp quản làm AI dừng.

Kích thước dự kiến sau khi xoá: khoảng 35 nghìn dòng, phần lớn là test và code đã chạy thật.

### P2-zalo · `modules/zalo` (AGPL-3.0)

**Giữ (copy):**
- `src/zalo/{session, daemon, control, supervisor, ingest, history, sender, limits, send-window, content, rich-text, template, variants, stickers, media, media-cache, profiles, turn-images, group-broadcast, list-broadcast, birthday, birthday-schedule, schedule, broadcast-cost, marketing-deps, dashboard-routes, routes-templates, routes-group-broadcast, routes-list-broadcast, routes-birthday, customer-care-types}`.
- `customer-care/connectors/zalo/**`.
- Các đoạn trong `db.ts`: `@zalo-schema:*`, `@zalo-db:*`, `@zalo-migrations:*`, cùng bảng `zalo_*` gốc.
- Web: `ZaloAccounts`, 4 trang `Marketing*`, `components/marketing/*`, `care-channels/zalo/*`, `lib/zalo`, `ZaloServiceBanner`, `lib/richText`.

**Bỏ (F):**
- `responder`, `gate`, `agent-turn`, `care-fence`, `care-delivery`, `daemon-care` (đường AI cũ; AI giờ đi qua care).
- `routes-customer-care` (Customer 360 đã có trong care).
- Trang `ZaloAgents`, `ZaloChat`.

Agent sẽ kiểm lại từng file: file nào còn được phần giữ lại import thì giữ.

**Nối lại:**
- `supervisor` + `daemon` → `start(ctx)` / `stop(ctx)` của module, chạy tiến trình con bằng `tsx` / `node`.
- Token điều khiển và cổng lấy từ settings của module.
- Kill switch → settings.

**License:** `modules/zalo/LICENSE` (AGPL-3.0) và `NOTICE` liệt kê 15 file có gốc ZaloCRM cùng nguồn `full_crm/ZaloCRM`.

**Xong khi:**
- test copy xanh;
- daemon khởi động và tắt theo Add / Remove;
- tạo được mã QR thật (không đăng nhập);
- worker gửi hàng loạt bỏ qua nick offline;
- giới hạn chống khoá nick có test;
- connector care hoạt động với daemon giả.

### P2-gmail · `modules/gmail` (cần `care`)

**Giữ (copy):** `src/email/{gmail, parse, sync, sender, serialize, dto, time}`, `customer-care/connectors/email/**`, `@email-schema`, `@email-db`, `@email-migrations`, `EmailAccounts` + `components/email/*` cần dùng, `care-channels/email/*`.

**Bỏ (F):** `responder`, `agent-turn`, `gate`, `worker` (phần AI cũ), `notify`; trang `EmailInbox`, `EmailAgents`.

**Nối lại:** Composio → `ctx.connections.composio()`.

**Xong khi:**
- test copy xanh;
- đồng bộ với Composio giả;
- thư đến vào hộp thư care;
- trả lời đúng luồng thư.

### P2-marketing · `modules/marketing`

**Giữ (copy):**
- `src/fbstudio/{core, comments, analytics, notify, routes, index, types, agent-view}`.
- `@fbstudio-schema:{core, comments, analytics}`, `@fbstudio-db:{shared, core, comments, analytics}`, `@fbstudio-migrations:{core, comments, analytics}`.
- Web: `pages/fb/*` trừ `FbAds`, `components/fb/**` trừ `ads/`, `lib/fbstudio`, `SocialOverview` (chỉ phần Facebook), `lib/marketing`.
- Skill `fb-content`, `fb-comment-reply`.

**Bỏ (F):** `whop-social`, các nền tảng khác trong `SocialHome` / `ChannelStrip` (để sau), `fbstudio-cli` (chuyển thành lệnh `aios module marketing …` nếu kịp).

**Nối lại:**
- `composio.ts` → client dùng chung.
- `graphAsPage` giữ nguyên.
- Lượt phân tích, trả lời bình luận và chat trong Kho nội dung → `runLean` và chat lõi.
- `notify` → attention.

**Xong khi:**
- test copy xanh;
- pipeline bình luận chạy với Composio giả;
- bộ đăng bài chạy với Composio giả;
- **không gọi Facebook thật trong test**.

### P2-ads · `modules/ads`

**Giữ (copy):** `src/fbstudio/ads/**`, `@fbstudio-db:ads`, `@fbstudio-migrations:ads`, `FbAds`, `components/fb/ads/**`, cùng bản copy của các thành phần chart và `common` mà trang Ads cần. Module không import nội bộ của module khác.

**Nối lại:**
- Composio → client dùng chung.
- Danh sách "bài organic nên chạy quảng cáo" lấy qua `ctx.modules.get('marketing')?.provides.topPosts`. Không có `marketing` thì ẩn khối này.

**Xong khi:**
- test copy xanh, gồm quy tắc R1–R5 và tính chỉ số;
- worker chụp số liệu chạy với dữ liệu mẫu;
- **không có lệnh ghi nào sang Meta**.

### Cổng P2 (mình)

1. Toàn bộ test + `check-provenance`.
2. e2e: Add `care` + `zalo` + `gmail` + `marketing` + `ads` trên giao diện → cấp scope cho agent → tin Zalo giả → nháp → duyệt.
3. Remove `zalo`: dữ liệu vẫn còn.
4. Purge: bảng bị xoá.

---

## 6. P3: Ghép, thử thật, tài liệu (mình)

1. Sửa lỗi tích hợp. Chạy e2e Playwright các luồng chính.
2. **Thử thật, chỉ khi bạn cho phép từng mục:**
   1. Composio: đọc danh sách Page; đăng rồi xoá một bài trên Page thử "Ninh Bình Home".
   2. Gmail: đồng bộ đọc.
   3. Meta Ads: cần kết nối lại, vì kết nối cũ đã hết hạn.
   4. Zalo: một nick thử do bạn quét QR; chỉ nhắn cho chính bạn.
3. `THIRD_PARTY_NOTICES.md`, `LICENSE` của lõi (chờ bạn chọn), README.
4. Bộ bài học tiếng Việt trong `docs/lessons/`:
   1. kiến trúc;
   2. thêm agent;
   3. phân quyền;
   4. thêm runtime;
   5. giao việc và chỉ thị;
   6. bộ nhớ, Second Brain, skill;
   7. viết module từ `_template`;
   8. đọc module `care` làm ví dụ lớn.

---

## 7. Rủi ro và cách giảm

| Rủi ro | Cách giảm |
|---|---|
| Code copy phụ thuộc ngầm vào lõi GỐC (biến toàn cục, `process.env`, đường dẫn `store/`) | P0.4 quét symbol; lớp compat; test đã copy phát hiện chỗ sai |
| `care` quá lớn với vai trò template | Giữ nguyên vì đã chạy thật. Bài học số 8 chỉ đọc phần `domain` và `application`. Có thể làm `care-lite` sau |
| Lệch phiên bản TS / Vitest khi copy | Đã căn version ở mục 1 |
| Vô tình copy code upstream | `check-provenance` chạy trong `npm test`; công cụ copy từ chối file có ở upstream |
| AGPL lan sang lõi | Zalo tách thành module riêng có LICENSE riêng. Lõi không import gì từ `modules/zalo` |
| CLI đổi cờ hoặc định dạng JSON | `doctor()` kiểm phiên bản; fixture được lấy từ lần chạy thật |

## 8. Cần bạn

- **Bắt đầu:** bạn nói "chạy" là mình làm P0, rồi P1.
- **Thử thật ở P3:** mình hỏi từng mục trước khi làm.
- **License của lõi** (MIT hay license riêng): không chặn build.
