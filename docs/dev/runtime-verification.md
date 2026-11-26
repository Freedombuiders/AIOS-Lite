# Kiểm chứng runtime (A-10)

Ngày kiểm: 2026-10-24, macOS 25.5 (arm64). Mọi lệnh gọi đi qua adapter trong `src/runtimes/` (trừ khi ghi "CLI trực tiếp"). Prompt chỉ vài từ, tổng chi phí khoảng 1 USD (đa phần là Claude không bật cache).

| CLI | Phiên bản | Đăng nhập dùng khi kiểm |
|---|---|---|
| Claude Code | 2.1.310 | `claude auth` (claude.ai) |
| Codex | codex-cli 0.163.0 | `~/.codex/auth.json` |
| Grok Build | 1.0.67 (2fe064390d07) | `~/.grok/auth.json` |
| Hermes (Rocket Agent) | v0.20.0 (2026.7.19) | provider `openai-codex`, home riêng (xem mục Hermes) |

Thư mục làm việc: `/private/tmp/claude-501/.../scratchpad/live-runtime/work` (không phải dự án thật). Với các phép thử sandbox của Grok, file "bí mật" phải nằm ngoài `/tmp` nên được đặt tạm ở `~/.aios-live-outside/` rồi xoá.

## 1. Bốn CLI trả lời "hello" qua adapter

| Runtime | Chế độ | Thời gian | Token (vào / ra / cache) | Chi phí | Kết quả |
|---|---|---|---|---|---|
| claude | safe, tools mặc định | 3,3 s | 14 688 / 4 / 0 | 0,0588 USD (cache lạnh) | `hello` |
| codex | safe | 5,9 s | 20 298 / 5 / 12 032 | không báo | `hello` |
| grok | safe | 4,9 s | 13 557 / 86 / 1 664 | 0,0097 USD | `hello` |
| hermes | ACP, home riêng | 6,0 s | 11 854 / 5 / 0 | không báo | `hello` |

`doctor({probe:true})` cho cả bốn: pass/warn, đều gọi "hello" thành công trong 4–6 s.

Nối phiên (nhờ nhớ "BANANA" rồi hỏi lại): claude, codex (`exec resume`), grok (`--resume`), hermes `chat --resume` và hermes ACP `session/load` đều trả `BANANA` và giữ nguyên session id.

## 2. Claude: `--restricted` (kiểm tra 2)

| Phép thử | Kết quả |
|---|---|
| Đọc `outside/secret.txt` khi không có `--add-dir` | **Chặn**: "is outside …/work; --restricted…" (CLI trực tiếp và qua adapter) |
| Đọc cùng file khi `--add-dir outside` | Đọc được (`TOPSECRET-OUTSIDE-42`) |
| Ghi vào thư mục chỉ có quyền đọc (có `--add-dir`) | **Chặn** nhờ `--disallowedTools "Write(//<dir>/**)"` (cú pháp `//` = đường dẫn tuyệt đối) |
| Gọi Bash ở `safe` | Không có công cụ Bash (init liệt kê chỉ Read/Edit/Write/…) |
| MCP `aiosfake` với `allowedTools=[ping, env_probe]` | `ping` và `env_probe` chạy (env của server tới nơi), `secret_dump` bị từ chối. MCP cá nhân không nạp (`--strict-mcp-config`) |
| `full` + mẫu tool hạn chế | Phải dùng `acceptEdits` + `--allowedTools`; `--dangerously-skip-permissions` sẽ cho mọi tool của server. Đã kiểm: `ping` chạy, `env_probe` bị từ chối |
| `tools: 'none'` | `--restricted --tools "" --disable-slash-commands --max-turns 1`: không công cụ nào chạy (mô hình có thể viết giả lệnh trong văn bản nhưng không có gì thực thi) |

Ghi chú: ở chế độ `full` + Opus 5.5 một prompt nói về "secret_dump" bị API gắn cờ an toàn (`stop_reason: refusal`, exit 0). Adapter nhận ra qua `stop_reason` và trả `family: 'refusal'`; chạy lại bằng Sonnet bình thường.

## 3. Codex (kiểm tra 3)

| Phép thử | Kết quả |
|---|---|
| `--ignore-user-config` một mình | **Không đủ**: vẫn liệt kê connector của tài khoản (Atlassian, Canva, Gmail, Google Drive, Linear, Zoom…). Không còn MCP trong `config.toml` (1devtool, chrome-devtools…) |
| `--ignore-user-config --disable apps --disable plugins` | Chỉ còn công cụ có sẵn: `clock`, `image_gen`, `web`. **Đây là bộ cờ adapter dùng** |
| `-c mcp_servers.<id>.enabled_tools=[…]` | Lọc cứng từng tool: `secret_dump` "không có tool này" |
| MCP cần `default_tools_approval_mode="approve"` | Không có thì `exec` từ chối mọi lệnh gọi MCP ("yêu cầu phê duyệt nhưng chính sách không cho phép") |
| `-c mcp_servers.<id>.env_vars=[NAME]` | Giá trị env tới server MCP qua env của tiến trình con, không nằm trong argv (`AIOS_PROBE=probe-env-ok`) |
| Đọc `~/.aios-live-outside/secret.txt` (sandbox `read-only`) | **Đọc được** (`cat` chạy): Codex không chặn đọc |
| Ghi ngoài cwd (`read-only` và `workspace-write`) | **Chặn** ("operation not permitted") |
| `tools: 'none'` | `--ephemeral -s read-only --disable shell_tool --disable unified_exec --disable image_generation --disable multi_agent -c web_search="disabled"`: "Không có công cụ shell hoặc đọc file" |
| `exec resume` | Không nhận `-C`, `-s`, `--add-dir`: adapter dùng cwd của tiến trình + `-c sandbox_mode=…` / `-c sandbox_workspace_write.writable_roots=[…]`. Đã kiểm nối phiên chạy được |

## 4. Grok (kiểm tra 4)

Hồ sơ sandbox có sẵn (`grok --sandbox`): `off` (mặc định), `workspace`, `devbox`, `read-only`, `strict`; thêm hồ sơ riêng trong `.grok/sandbox.toml` (cwd) hoặc `~/.grok/sandbox.toml`.

| Phép thử | Kết quả |
|---|---|
| `strict`, `read_file` ngoài cwd (trong home) | **Chặn** ("Permission denied") |
| `strict`, shell `cat`/ghi ngoài cwd | **Chặn** ("Operation not permitted") |
| `strict`, đọc file trong `/tmp` | Đọc được: `/tmp` nằm trong "system paths" của `strict` (vì vậy file thử phải đặt trong home) |
| `read-only`, shell `cat` file trong home | Đọc được; ghi vào home bị chặn |
| `workspace`, shell `cat` file trong home | Đọc được; ghi vào home bị chặn |
| `--add-dir` | **Grok từ chối** ("additionalDirectories is not supported: a session works only in its cwd") |
| Hồ sơ riêng `extends="strict"` + `read_only=[dir]` ghi vào `<cwd>/.grok/sandbox.toml` | Đọc được thư mục thêm, ghi vào đó bị chặn; không cần "trust" thư mục. **Adapter dùng cách này** |
| `--rules @file` | **Không đọc file**: nhận nguyên văn "@file" làm luật. Phải truyền chính nội dung (`--rules "<text>"`); nội dung > 100 KB thì ghép vào file prompt |
| `--prompt-file` | Chạy headless được, adapter dùng thay `--single <prompt>` (không lộ prompt trong `ps`) |
| `--tools ""` | Bị bỏ qua (vẫn đủ công cụ). `--tools todo_write` chỉ còn `todo_write` + cổng MCP rỗng: **adapter dùng làm chế độ không công cụ**. `--tools none` chỉ cảnh báo |
| MCP cá nhân | Mặc định Grok nạp cả MCP của `~/.claude.json` (208 tool, 12 server). `GROK_CLAUDE_MCPS_ENABLED=false GROK_CURSOR_MCPS_ENABLED=false` đưa về 27 tool. Adapter luôn tắt thêm hooks/agents/rules/skills tương thích |
| `--plugin-dir` | Chỉ có ở `grok agent`, không có ở `grok --single`. MCP theo lượt chạy đi qua `<cwd>/.grok/config.toml` (`[mcp_servers.<id>]`) + `--trust` |
| `--permission-mode acceptEdits` + MCP | Headless từ chối mọi lệnh MCP ("headless run cannot ask for approval"); `--allow MCPTool(...)`/`mcp__…` không giúp. Phải `--always-approve` (kết hợp sandbox + tắt shell) |
| MCP dưới sandbox `strict` | Server MCP **không khởi động được** ("Tool not found"). Dưới `workspace` thì chạy: `ping` và `env_probe` trả đúng |
| `safe` + MCP trong adapter | Chuyển sang sandbox `workspace` (đọc được mọi nơi, ghi chỉ trong thư mục cấp), tắt shell; có sự kiện `status` cảnh báo |
| `--trust` | Ghi vĩnh viễn thư mục vào `~/.grok/trusted_folders.toml`. Chấp nhận được vì cwd là workspace của agent; bản thử của tôi đã khôi phục file này |
| `full` | `--always-approve`, không sandbox: shell chạy |

## 5. Hermes (kiểm tra 5)

| Phép thử | Kết quả |
|---|---|
| `initialize` | `agentCapabilities.loadSession: true`, `promptCapabilities.image: true` |
| `session/new` với `mcpServers: []` | Chấp nhận, trả lời "hello" (6 s) |
| `session/new` với `mcpServers=[aiosfake]` | Server được nạp, `mcp_aiosfake_ping` trả `pong` |
| MCP trong cấu hình của Hermes | **Vẫn nạp** khi khởi động, kể cả `--safe-mode`/`--ignore-user-config` (tôi thấy MCP `heygen` mở trình duyệt xin OAuth và chờ 60 s). Cách tránh: `HERMES_HOME` riêng hoặc profile không có `mcp_servers` |
| Mô hình mặc định trên máy này | Lỗi ("Model is unavailable"). Bản thử dùng `HERMES_HOME` riêng có `auth.json` + `config.yaml` (`openai-codex`/`gpt-5.6-sol`); adapter nhận `runtimeOptions.home` |
| ACP, `safe`, "chạy `echo hi`" | **Chạy luôn, không hỏi quyền** (ACP chỉ xin quyền cho lệnh nguy hiểm và sửa file). Bộ công cụ ACP cố định `hermes-acp` (có terminal), client không đổi được |
| ACP, `safe`, đọc file ngoài cwd | **Đọc được** (`read` không xin quyền) |
| `hermes chat -q … -t file,web,todo` | Không có công cụ shell ("NOSHELL"). **Adapter dùng cho `safe` mặc định** |
| `hermes chat -Q` | Câu trả lời ở stdout (kèm dòng `Activated Letta OS memory …` cần lọc); `session_id: <id>` ở stderr |
| Usage | `session/prompt` trả `usage{inputTokens, outputTokens, cachedReadTokens, thoughtTokens}` |

Chọn chế độ (`runtimeOptions.mode = auto | acp | cli`, mặc định `auto`): agent `full` hoặc có MCP được cấp chạy ACP (nhận `mcpServers`, có streaming); còn lại chạy CLI (là cách duy nhất tắt được shell). Khi `safe` mà phải đi ACP, adapter phát sự kiện `status` cảnh báo.

## 6. Bảng mức chặn cuối cùng (chế độ `safe`)

`hard` = CLI/OS ép; `soft` = chỉ một phần hoặc phụ thuộc cấu hình; `none` = không chặn. Giá trị trùng `capabilities.enforces`.

| Runtime | Ngữ cảnh/module | MCP | Đọc file | Ghi file | Shell |
|---|---|---|---|---|---|
| **Claude** | hard | **hard** (`--strict-mcp-config` + `--allowedTools`) | **hard** (`--restricted`, `--add-dir`) | **hard** (+ `--disallowedTools Edit/Write` cho thư mục chỉ đọc) | **hard** (bỏ Bash) |
| **Codex** | hard | **hard** (`--ignore-user-config --disable apps plugins`, `enabled_tools`) | **none** | **hard** (sandbox) | soft (sandbox chặn ghi, vẫn đọc/mạng) |
| **Grok** | hard | soft (server hard, lọc tool mềm) | soft (hard với `strict`; MCP buộc dùng `workspace`) | **hard** (sandbox) | **hard** (bỏ `run_terminal_command`) |
| **Hermes** | hard | soft (MCP của Hermes tự nạp) | **none** | **none** (ACP: chặn sửa file ngoài thư mục qua xin quyền, shell vẫn ghi được) | soft (hard ở CLI `-t file,web,todo`, none ở ACP) |
| GenBot | hard | hard (luồng Bot API không có MCP) | hard (không công cụ đọc file) | hard | hard (không shell) |
| mock | hard | hard | hard | hard | hard |

Dòng GenBot là lời khai theo `genbot/desktop/docs/bot-api.md` ("What a call may do"), **chưa kiểm thật**: xem mục 9.

`full` không chặn thêm gì (Claude vẫn giới hạn MCP bằng `--allowedTools` khi có mẫu tool).

## 7. Điều lệch so với giả định ban đầu (cần cập nhật ARCHITECTURE §5.3)

1. Hermes không "hard" ở đọc/ghi/shell qua ACP như bảng 5.3 ghi. Phải dùng CLI + `-t` để tắt shell, và vẫn không giới hạn được thư mục.
2. Grok `--rules @file` không đọc file; `--add-dir` bị từ chối; MCP không chạy trong `strict`.
3. Codex cần `--disable apps --disable plugins` ngoài `--ignore-user-config`, và `default_tools_approval_mode="approve"` cho MCP.
4. Hermes cần `HERMES_HOME`/profile riêng để không nạp MCP cá nhân và để có mô hình dùng được.
5. `RunEvent.text` được phát dạng **delta** (Grok/Hermes) hoặc cả khối tin nhắn (Claude/Codex); người nhận nên nối lại, còn `RunResult.output` luôn là tin nhắn cuối.
6. `Usage.inputTokens` gồm cả token cache ở mọi runtime (Claude cộng `cache_read` + `cache_creation`; Codex đã sẵn gồm); `cachedInputTokens` là phần cache đọc.

## 8. Cách tái kiểm

- Test đơn vị (CLI giả, máy chủ GenBot giả): `npx vitest run src/runtimes` (179 test ngày 2026-11-26).
- Kiểm thật: dựng `createRuntimeRegistry()` rồi gọi `run()` với `makeReq` trong `src/runtimes/test-util.ts`; `doctor({ probe: true })` chạy "hello" cho từng CLI.
- Fixture sự kiện thật (đã xoá id/đường dẫn): `test-fixtures/runtimes/events/*.jsonl`; MCP thử: `test-fixtures/runtimes/fake-mcp.mjs`.

## 9. GenBot (Bot API qua HTTP)

Thêm ngày 2026-11-26. Adapter `src/runtimes/genbot.ts` không chạy CLI nào: mỗi lượt là `POST {base_url}/hooks/api/bots/{bot_id}/messages` với `Authorization: Bearer <process.env[key_env]>` và thân `{ message, wait }`, `wait ≤ 50` giây.

**Chưa kiểm với GenBot thật.** Mọi kết quả dưới đây là với máy chủ giả `test-fixtures/runtimes/fake-genbot.mjs`. Hợp đồng HTTP lấy từ `genbot/desktop/docs/bot-api.md` (POST và GET) và `genbot/desktop/server/bot-api-host.ts`. GET trả `200 {reply, thread}` hoặc `202 {thread, status}`, không tốn lượt POST, và trả `404` cho luồng không do API mở.

| GenBot trả | Adapter trả | Ghi chú |
|---|---|---|
| `200 {reply, thread}`, reply có chữ | `ok`, `output = reply` | `usage` để trống |
| `200` với reply rỗng hoặc thiếu | `unknown` | GET đọc một lượt đã lỗi sau `202` thành reply rỗng: không coi là trả lời |
| `202 {thread, status: "working"}` | đọc lại `GET …/messages?thread=<id>` mỗi 2 giây | Cùng một hạn chót `timeoutMs` cho xếp hàng, POST và GET; hết giờ là `timeout` |
| `202 needs_approval` | `access`, lời nhắn có mã luồng | Engine nổi mục "Cần bạn" cho `access`; chủ mở app GenBot để duyệt |
| `3xx` | `config` | Không theo chuyển hướng (khoá sẽ đi theo) |
| `400`, `413`, `415`, `403` | `config` | `403` cũng là bot không tồn tại, gói Cloud Starter, hoặc AI của bot không chạy nhốt được |
| `401` | `auth` | |
| `404` | `config`, `clearSession: true` | Luồng không còn; dừng đọc lại |
| `409` | `transient` | Không tự thử lại |
| `429` | `quota`, `retryAfter` +60 giây | GenBot không gửi `Retry-After`; nếu có thì adapter dùng. `retryAfter` được giữ trong `task.meta` và trả về module qua `LeanRunResult.retryAfter` |
| `502` | `unknown` | Lý do nằm trên thẻ Bot API trong app, không nằm trong phản hồi |
| lỗi mạng trước khi gửi | `transient` | "Không kết nối được GenBot" |
| lỗi mạng sau khi đã gửi | `transient` | Không rõ GenBot đã nhận chưa; **không** gửi lại (không có khoá chống trùng) |
| `signal` bị huỷ | `cancelled` | Ngắt kết nối HTTP; GenBot có thể vẫn trả lời xong trong luồng của nó |

Lỗi trả về có dạng `{ error: "…" }`; adapter chép lời đó (cắt 200 ký tự) vào `message`, sau khi che khoá.

Bảo vệ khoá: `key_env` phải có dạng `GENBOT_KEY_*`; mọi tên `GENBOT_KEY_*` và mọi `key_env` của agent bị gỡ khỏi môi trường tiến trình con ở mọi lớp (kể cả biến được cấp), `connections.yaml` không chép được giá trị qua `$TÊN`, `ctx.connections.secret()` không đọc được, và giá trị bị che bởi `redactString`. Test: `src/runtimes/genbot-secrets.test.ts` (Claude và Codex giả không thấy biến).

Đường truyền: `http://` chỉ tới 127.0.0.1, localhost, ::1; máy khác phải `https://`.

Giới hạn: mỗi bot (`base_url` + `bot_id`) 10 POST mỗi 60 giây và tối đa 4 lượt mở cùng lúc, giữ trong bộ nhớ của một tiến trình AIOS.

Cách kiểm thật (cần GenBot đang chạy và một bot đã bật Bot API):

1. Đặt khoá vào `.env`: `GENBOT_KEY_CSKH=…`, khởi động lại AIOS.
2. Tạo agent `runtime: genbot` với `runtime_options.base_url`, `bot_id`, `key_env`.
3. `curl -X POST localhost:<cổng>/api/runtimes/genbot/check -H 'content-type: application/json' -d '{"agentId":"<id>","probe":true}'`: phải có `genbot.probe` mức `info`.
4. Nhắn agent ở `/chat`; trong app GenBot phải thấy một luồng mới đánh dấu gửi qua Bot API.
5. Ghi kết quả (thời gian trả lời, mã lỗi gặp được) vào mục này.
