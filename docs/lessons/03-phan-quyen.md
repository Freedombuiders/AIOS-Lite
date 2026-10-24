# Bài 3. Phân quyền

Sau bài này bạn có thể:

- Liệt kê những thứ AIOS-Lite kiểm soát và khai báo cấp quyền cho agent ở đâu.
- Giải thích hai lớp bảo vệ: lớp **prompt** (luôn chặn cứng) và lớp **CLI** (mạnh yếu tuỳ runtime).
- Đọc bảng chặn cứng / chặn mềm thật của bốn runtime và chọn runtime phù hợp cho dữ liệu nhạy cảm.
- Biết vì sao dữ liệu module luôn chặn cứng, và tra nhật ký để biết agent đã làm gì.

## 3.1 Mặc định không cấp gì

Agent mới tạo, chưa khai `access`, thì **không đọc được thư mục Second Brain nào, không dùng MCP nào, không có skill nào, không có quyền với module nào**. Chỉ `memory.private` mặc định bật (`src/agents/schema.ts:19`).

Mọi quyền phải ghi rõ trong khối `access` của `agent.yaml`:

```yaml
access:
  brain:
    cong-ty-a:     { read: ["**"], write: [] }       # đọc cả thư mục, không ghi
    cong-ty-a-sop: { read: ["Ban-hang/**"] }          # chỉ đọc thư mục con
  memory: { team: true, private: true }
  skills: [tra-loi-khach, bao-gia]                    # hoặc: all
  connections:
    github: ["search_*"]                              # MCP: chỉ các tool khớp mẫu
  modules:
    care:  [inbox.read, reply.draft]                  # quyền dữ liệu của module
```

## 3.2 Những thứ được kiểm soát

| Tài nguyên | Khai báo nguồn ở | Cấp cho agent bằng | Chặn bởi |
|---|---|---|---|
| Thư mục Second Brain | `config/brain.yaml` | `access.brain.<id>: {read, write}` (mẫu glob) | Bộ dựng prompt; CLI (sandbox, tuỳ runtime) |
| Bộ nhớ | bảng `memories` | `access.memory: {team, private}` | Bộ dựng prompt |
| MCP server | `config/connections.yaml` (`type: mcp`) | `access.connections.<id>: ["mẫu"]` hoặc `true` | CLI (tuỳ runtime) |
| Khoá API | `connections.yaml` (`type: env`) | `access.connections.<id>: true` | Biến môi trường của tiến trình con |
| Composio | `connections.yaml` (`type: composio`) | **không cấp cho agent** | Chỉ module gọi Composio |
| Skill | `skills/` và skill của module | `access.skills: [...]` hoặc `all` | Bộ dựng prompt |
| Dữ liệu module | `scopes` trong `module.json` | `access.modules.<id>: [scope]` | Module và engine |
| Mức quyền CLI | `permission` | `safe` hoặc `full` | CLI |

Ví dụ `config/connections.yaml` (chỉ ghi **tên** biến môi trường, không ghi khoá thật):

```yaml
connections:
  - id: composio
    type: composio
    description: Composio, dùng cho các module
    apiKeyEnv: COMPOSIO_API_KEY

  - id: github
    type: mcp
    description: GitHub qua MCP
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: $GITHUB_TOKEN
```

`$GITHUB_TOKEN` được thay bằng giá trị trong `.env` lúc chạy (`resolveEnvRefs`, `src/core/env.ts:60`). Nếu biến trống, policy **không khởi động server MCP đó** thay vì khởi động một server hỏng (`src/access/policy.ts:47`).

Cấp Composio cho agent bị bỏ qua có chủ đích (`policy.ts:59`): khoá Composio chỉ nằm ở phía server của module, agent không bao giờ cầm nó.

## 3.3 Thư mục Second Brain và mẫu glob

`config/brain.yaml` khai các thư mục, mỗi thư mục là một nguồn độc lập:

```yaml
folders:
  - id: ca-nhan
    name: Cá nhân
    path: ./brain/ca-nhan
  - id: cong-ty-a
    name: Công ty A — Nội thất Hạ Long
    path: ./brain/cong-ty-a        # trỏ sang vault Obsidian thật cũng được (hỗ trợ ~)
```

Quyền theo từng thư mục và từng mẫu đường dẫn. Bộ so khớp ở `src/shared/glob.ts`:

| Mẫu | Khớp |
|---|---|
| `**` | mọi thứ, mọi độ sâu |
| `Ban-hang/**` | mọi thứ dưới `Ban-hang/` |
| `*.md` | file `.md` ở **cấp gốc** (một dấu `*` không vượt qua dấu `/`) |
| `?` | đúng một ký tự trong một đoạn đường dẫn |

Đường dẫn tuyệt đối hoặc có `..` bị từ chối ngay (`normalizeRel`, `glob.ts:28`), nên không thể thoát ra ngoài thư mục bằng `../`. `BrainService.read/write` còn kiểm tra symlink trỏ ra ngoài (`src/shared/brain.ts`, hàm `safePath`).

Thử bằng chứng. Với hai agent mock dưới đây, cùng câu hỏi về "chính sách đại lý" (nằm trong `cong-ty-b`):

```
demo        (đọc ca-nhan, cong-ty-a, cong-ty-b)  → thấy cong-ty-b/chinh-sach-dai-ly.md
tro-ly-thu  (chỉ đọc cong-ty-a)                  → chỉ thấy các ghi chú của cong-ty-a
canReadPath('tro-ly-thu', 'cong-ty-b', 'chinh-sach-dai-ly.md') → false
```

Kết quả này lấy từ lần chạy thật `context.build` và `access.canReadPath` trên bản sao của repo. Agent thứ hai không bao giờ thấy ghi chú của Công ty B trong prompt, vì **bộ tìm kiếm chỉ được phép tìm trong các thư mục agent có quyền đọc** (`searchForAccess`, `src/shared/brain.ts`).

## 3.4 Một chỗ tính quyền: `resolve`

Mọi quyết định gom về hàm `resolve` của `createAccessPolicy` (`src/access/policy.ts:36`). Mỗi lượt chạy, engine gọi nó (`engine.ts:188`) và nhận về `EffectiveAccess` (định nghĩa ở `src/access/contracts.ts:24`):

```ts
interface EffectiveAccess {
  agentId: string;
  readDirs: DirGrant[];      // thư mục brain được đọc (kèm mẫu glob)
  writeDirs: DirGrant[];     // thư mục brain được ghi
  addDirs: string[];         // thư mục hẹp nhất bao mỗi quyền đọc, để truyền cho CLI
  memory: { team: boolean; private: boolean };
  mcpServers: McpGrant[];    // đã giải biến môi trường (có bí mật, không được log)
  envVars: Record<string, string>;
  skills: Skill[];
  moduleScopes: Record<string, string[]>;   // chỉ module ĐÃ BẬT
  permission: 'safe' | 'full';
  tools: 'default' | 'none';                // lean thì 'none'
}
```

Ba chi tiết hay bị bỏ sót:

- `moduleScopes` chỉ chứa module **đang bật** (`policy.ts:62`). Gỡ module thì quyền của nó biến mất khỏi mọi agent mà không cần sửa `agent.yaml`.
- `tools` là `none` khi Task `lean` (`policy.ts:78`). Đó là cách một lượt trả lời khách không có công cụ nào.
- `can(agentId, moduleId, scope)` (`policy.ts:103`) trả `false` nếu agent không tồn tại, đang tắt, hoặc module chưa bật. Scope `*` và mẫu glob đều được hỗ trợ.

Trước khi lưu vào Run, quyền được chụp lại **không kèm bí mật** (`snapshot`, `policy.ts:94`): MCP chỉ còn id và danh sách tool, biến môi trường chỉ còn tên khoá. Bản chụp này nằm ở cột `runs.access_json`.

Xem quyền sẽ áp dụng cho một agent:

```bash
curl -s http://127.0.0.1:4380/api/agents/demo/access
```

Phản hồi gồm `access` (bản chụp), `enforcement` (mức chặn của runtime, mục 3.5) và `runtime`. Trang agent, tab **Quyền**, hiển thị đúng dữ liệu này.

## 3.5 Hai lớp bảo vệ

```
        AIOS-Lite quyết định                         CLI thực thi
  ┌──────────────────────────────┐        ┌──────────────────────────────────┐
  │ LỚP PROMPT (luôn chặn cứng)  │        │ LỚP CLI (tuỳ runtime)            │
  │  · brain: chỉ tìm trong      │        │  · MCP nào được nạp              │
  │    thư mục được đọc          │        │  · đọc file ngoài thư mục?       │
  │  · bộ nhớ: team/private      │        │  · ghi file ở đâu?               │
  │  · skill: chỉ skill được cấp │        │  · có shell không?               │
  │  · dữ liệu module: theo scope│        │                                  │
  └──────────────────────────────┘        └──────────────────────────────────┘
        context.build() ───────────────►  adapter dịch EffectiveAccess thành cờ
```

**Lớp prompt luôn chặn cứng ở mọi runtime**, vì chính AIOS-Lite là bên quyết định đưa gì vào prompt. Nếu một ghi chú không nằm trong prompt, agent không thể "đọc lỏm" nó qua prompt. Bộ dựng prompt (`src/shared/context.ts:135` đến `149`) chỉ gọi `memory.recall` với đúng cờ `team`, `private` và `brain.searchForAccess` với đúng `readDirs` của agent.

**Lớp CLI** là phần còn lại: agent chạy bằng CLI có công cụ riêng (đọc file, shell, MCP). AIOS-Lite chỉ có thể **nhờ** CLI chặn bằng cờ, và mỗi CLI chặn được đến đâu thì khác nhau. Để biết sự thật thay vì tin tài liệu, bản kiểm thật ngày 24/10/2026 đã chạy từng CLI và thử đọc, ghi, gọi shell, gọi MCP trái phép (chi tiết ở `docs/dev/runtime-verification.md`).

### Bảng chặn thật (chế độ `safe`)

`hard` = CLI hoặc hệ điều hành ép; `soft` = chỉ một phần hoặc phụ thuộc cấu hình; `none` = không chặn. Giá trị trùng `capabilities.enforces` trong mã (`src/runtimes/*.ts`) và hiện ở tab Quyền.

| Runtime | Dữ liệu đưa vào prompt | MCP | Đọc file | Ghi file | Shell |
|---|---|---|---|---|---|
| **Claude** | hard | **hard** | **hard** | **hard** | **hard** (bỏ Bash) |
| **Codex** | hard | **hard** | **none** | **hard** | soft |
| **Grok** | hard | soft | soft (hard với sandbox `strict`) | **hard** | **hard** (bỏ shell) |
| **Hermes** | hard | soft | **none** | **none** | soft |
| mock | hard | hard | hard | hard | hard (không chạy công cụ nào) |

Đọc bảng này như sau, mỗi dòng kèm bằng chứng đã kiểm:

| Runtime | Điều đã kiểm | Nghĩa là gì cho bạn |
|---|---|---|
| Claude | Đọc file ngoài thư mục khi không có `--add-dir`: bị chặn. Ghi vào thư mục chỉ-đọc: bị chặn nhờ `--disallowedTools Write(//dir/**)`. Gọi Bash: không có công cụ này. MCP chỉ chạy tool trong `allowedTools` | Chọn Claude cho thư mục nhạy cảm |
| Codex | `--ignore-user-config` **một mình chưa đủ**: vẫn thấy connector của tài khoản (Gmail, Drive...). Phải thêm `--disable apps --disable plugins`. Đọc `~/.aios-live-outside/secret.txt`: **đọc được**. Ghi ngoài thư mục: bị chặn | Codex đọc được file ngoài thư mục làm việc. Đừng cấp dữ liệu nhạy cảm |
| Grok | Sandbox `strict` chặn đọc và ghi ngoài thư mục; nhưng **MCP không khởi động được dưới `strict`**, nên khi agent có MCP phải dùng `workspace` (đọc được mọi nơi). `--add-dir` bị Grok từ chối; thư mục thêm đi qua hồ sơ sandbox riêng. Lọc từng tool MCP chỉ mềm | Grok an toàn khi **không có MCP**; có MCP thì đọc file là mềm |
| Hermes | Qua ACP, lệnh `echo hi` chạy luôn không hỏi, đọc file ngoài thư mục được. `hermes chat -t file,web,todo` bỏ được shell. Hermes tự nạp MCP trong cấu hình riêng, kể cả khi `--safe-mode` | Hermes không chặn cứng đọc/ghi. Đặt `runtime_options.home` riêng để khỏi nạp MCP cá nhân |

**Hệ quả thực dụng** (đã chốt trong thiết kế):

1. Dữ liệu module, bộ nhớ và Second Brain đưa vào prompt luôn chặn cứng ở mọi runtime.
2. **Thư mục nhạy cảm chỉ cấp cho agent chạy Claude, hoặc Grok không có MCP.** Codex và Hermes đọc được file ngoài thư mục: tab Quyền hiện nhãn đỏ "Không chặn" ở dòng "Đọc file" cho hai runtime này.
3. Muốn cách ly tuyệt đối thì chạy agent trong container (bài mở rộng, chưa có trong template).

### Xem cờ thật mà adapter sinh ra

Hàm dựng cờ là hàm thuần, bạn gọi được mà không chạy CLI nào. Với agent có quyền đọc thư mục `cong-ty-a` và một MCP `github` chỉ cho tool `search_*`, đây là lệnh Claude thật sự nhận (đã chạy `buildClaudeArgs` trong `src/runtimes/claude.ts:68`, rút gọn đường dẫn):

```
claude -p --output-format stream-json --verbose
  --append-system-prompt-file <runDir>/system.md
  --strict-mcp-config --mcp-config <runDir>/mcp.json
  --restricted --permission-mode acceptEdits
  --disallowedTools Edit(//brain/cong-ty-a/**) Write(//brain/cong-ty-a/**) NotebookEdit(//brain/cong-ty-a/**)
  --add-dir /brain/cong-ty-a
  --allowedTools mcp__github__search_*
```

Đọc từng cờ:

- `--strict-mcp-config` + `--mcp-config`: **chỉ** nạp MCP được cấp, bỏ MCP cá nhân của bạn.
- `--restricted`: bỏ Bash, giới hạn đọc ghi trong thư mục làm việc và `--add-dir`.
- `--add-dir`: thư mục được đọc (lấy từ `addDirs`).
- `--disallowedTools Write(//...)`: thư mục chỉ có quyền đọc thì cấm ghi (`//` nghĩa là đường dẫn tuyệt đối).
- `--allowedTools mcp__github__search_*`: chỉ tool khớp mẫu.

Cũng agent đó nhưng trong lượt `lean` (tools `none`):

```
claude -p --output-format stream-json --verbose --max-turns 1
  --append-system-prompt-file <runDir>/system.md
  --strict-mcp-config --restricted --tools "" --disable-slash-commands
```

Không còn `--add-dir`, `--mcp-config`, `--allowedTools`: không công cụ nào. Với Codex, cùng quyền đó thành:

```
codex exec --json --skip-git-repo-check -C <cwd> -s read-only
  --ignore-user-config --disable apps --disable plugins
  -c approval_policy="never"
  -c shell_environment_policy.include_only=["PATH","HOME",...]   # shell chỉ thấy biến cốt lõi + biến được cấp
  -c mcp_servers.github.command="npx" -c mcp_servers.github.enabled_tools=["search_*"]
  -c mcp_servers.github.default_tools_approval_mode="approve" -
```

`-s read-only` là sandbox ghi; nhưng không có cờ nào ở đây giới hạn việc **đọc**. Đó chính là ô `none` trong bảng.

Giá trị khoá bí mật không bao giờ nằm trong tham số dòng lệnh: tên biến đi qua `env_vars`, giá trị đi qua môi trường của tiến trình con (`src/runtimes/codex.ts:178`), và mọi lệnh ghi nhật ký đều qua `describeCommand` để che (`src/runtimes/jsonl.ts:29`). Ngoài ra `buildChildEnv` (`src/runtimes/shared.ts:34`) luôn gỡ `AIOS_TOKEN`, `AIOS_ENCRYPTION_KEY`, `COMPOSIO_API_KEY` và các biến `CLAUDECODE*` khỏi môi trường của CLI, dù agent được cấp gì.

## 3.6 Scope của module: vì sao luôn chặn cứng

Module khai báo các **scope** trong `module.json`:

```json
"scopes": {
  "inbox.read":  "Đọc hộp thư và lịch sử hội thoại",
  "reply.draft": "Soạn nháp trả lời khách (chờ người duyệt)",
  "reply.send":  "Tự gửi trả lời cho khách (chế độ Tự động)"
}
```

Bạn cấp scope cho agent ở `access.modules.care: [inbox.read, reply.draft]`. Rồi có ba chỗ kiểm tra, đều nằm trong mã AIOS-Lite chứ không phải trong CLI:

1. **Dữ liệu đưa vào prompt.** Engine chỉ gọi `agentContext` của module nếu agent có ít nhất một scope của module đó (`engine.ts:82`, vòng lặp theo `moduleScopes`). Module tự lọc theo danh sách `scopes` truyền vào.
2. **Hành động của agent.** Khi agent viết `<aios-action module="..." name="...">`, engine tra scope cần cho hành động đó và chỉ chạy nếu agent được cấp đúng scope (`directives.ts:122`, `engine.ts:130`). Thiếu thì chỉ thị bị từ chối và ghi nhật ký.
3. **Việc module làm thay agent.** Module hỏi `ctx.access.can(agentId, 'reply.send')` trước mọi hành động. Ví dụ `care` thiếu scope `reply.send` thì chế độ Tự động **hạ xuống Nháp** (`modules/care/server/application/agent-turn.ts:564`).

Vì sao đây luôn là chặn cứng, bất kể runtime? Vì **agent không có đường nào khác tới dữ liệu đó**. Dữ liệu khách hàng nằm trong SQLite của module; CLI không có công cụ nào mở được nó; muốn thấy, agent chỉ có thể nhận qua prompt (do AIOS dựng) hoặc qua hành động (do engine kiểm quyền). Còn thư mục brain thì khác: nó là file trên đĩa, nên một CLI không chặn đọc (Codex, Hermes) vẫn có thể mở trực tiếp bằng công cụ file của chính nó.

Nói cách khác: **mọi thứ đi qua AIOS thì chặn cứng; mọi thứ CLI tự đụng vào thì phụ thuộc CLI.**

## 3.7 `safe` và `full`

`permission: safe` là mặc định và là chế độ bảng 3.5 mô tả. `full` bỏ các chặn của CLI:

- Claude vẫn giới hạn **MCP** bằng `--allowedTools` khi có mẫu tool (`claude.ts` dùng `acceptEdits` thay vì `--dangerously-skip-permissions`, vì `bypassPermissions` sẽ cho mọi tool của server).
- Codex dùng `danger-full-access`; Grok dùng `--always-approve` không sandbox; Hermes chạy ACP có terminal.
- Lớp prompt **không đổi**: agent `full` vẫn chỉ nhận dữ liệu đúng quyền.
- Lượt `lean` luôn bị ép không công cụ, kể cả agent `full` (`buildCodexArgs`: `full = permission === 'full' && !lean`).

Chỉ dùng `full` cho agent bạn tin và chạy trong thư mục làm việc riêng.

## 3.8 Nhật ký truy cập

Bảng `audit_log` ghi lại (xem `GET /api/audit` hoặc trang **Nhật ký**):

| `action` | Khi nào |
|---|---|
| `run.start` | Mỗi lượt chạy bắt đầu (có `run_id`; bản chụp quyền nằm ở `runs.access_json`) |
| `directive.rejected` | Một chỉ thị bị từ chối, kèm lý do |
| `directive.ignored` | Chỉ thị bị bỏ qua vì lượt `lean` |
| `module.action` | Agent gọi hành động module (thành công hay lỗi) |
| `agent.create`, `agent.update`, `agent.archive` | Người dùng đổi agent |
| `task.cancel`, `task.approve` | Người dùng huỷ hoặc duyệt việc |
| `module.add`, `module.remove`, `module.purge` | Vòng đời module |
| `connection.composio_key` | Đổi khoá Composio |
| `settings.emergency_stop_on/off` | Bật tắt nút dừng khẩn cấp |
| (do module ghi) | `ctx.audit.log(action, target, detail)`; actor mặc định `module:<id>` |

Mọi chi tiết đi qua `redactValue` trước khi ghi (`src/access/audit.ts:31`): chuỗi trông như khoá API, token, JWT bị thay bằng `[redacted]`, và giá trị dưới khoá có tên như `token`, `password`, `secret` bị che hẳn.

Một điều cần nói thật: các **lần gọi tool MCP** của agent không vào `audit_log`. Chúng được ghi thành sự kiện `tool` trong `run_events` của từng Run (xem `GET /api/runs/:id`). Muốn biết agent đã gọi tool nào trong một lượt, hãy xem Run chứ không phải nhật ký truy cập.

Một cách tra thực tế: "agent X đã được làm gì ở lượt này?"

```bash
curl -s http://127.0.0.1:4380/api/runs/12       # run.accessJson = quyền lúc đó; events = công cụ đã gọi
curl -s "http://127.0.0.1:4380/api/audit?actor=agent:cskh&limit=20"
```

## 3.9 Danh sách kiểm tra khi cấp quyền

- [ ] Agent này cần đọc thư mục nào? Chỉ ghi tên thư mục cần, và mẫu hẹp nhất có thể (`Ban-hang/**` thay vì `**`).
- [ ] Có cần `write` không? Mặc định để rỗng.
- [ ] Runtime của agent có chặn cứng việc đọc file không (bảng 3.5)? Nếu không, thư mục có nhạy cảm không?
- [ ] Có cần MCP không? Dùng mẫu tool hẹp (`search_*`) thay vì `true`.
- [ ] Agent xử lý nội dung từ bên ngoài? Hãy `context: lean`, `permission: safe`.
- [ ] Hành động ra ngoài (gửi tin, đăng bài) có cần `*.send` không? Mặc định chỉ cấp `*.draft`.
- [ ] Mở tab **Quyền** của agent, xem lại toàn bộ trước khi bật.

## Bài tập

1. Tạo agent mock `chi-doc` chỉ đọc `cong-ty-a`, và `xem-het` đọc cả ba thư mục. Tạo mỗi agent một Task hỏi về "chính sách đại lý". Dùng `GET /api/runs/:id` và đọc `accessJson` của hai Run: khác nhau ở đâu?
2. Mở `GET /api/agents/coder/access` (agent Codex) và `GET /api/agents/main/access` (Claude). So trường `enforcement`. Với dữ liệu khách hàng, bạn chọn agent nào, vì sao?
3. Viết `permision: safe` (sai chính tả) vào một `agent.yaml`. Đọc thông báo lỗi (xem bài 2) rồi nghĩ: nếu schema không `strict`, lỗi gõ nhầm kiểu này gây hại gì cho phân quyền?
4. (Đọc mã) Tìm trong `src/access/policy.ts` đoạn quyết định `tools: 'none'`. Một agent `permission: full` nhận Task `lean` thì có shell không? Dẫn dòng mã trả lời.
5. Thêm vào `config/connections.yaml` một MCP giả có `env: { TOKEN: $KHONG_CO_BIEN_NAY }` (biến không có trong `.env`) rồi cấp cho một agent (nhớ nạp lại cấu hình bằng cách khởi động lại API). Gọi `GET /api/agents/<id>/access`: `mcpServers` có gì? Vì sao?
6. Chạy `GET /api/audit?action=run.start` sau vài lượt chạy. Chọn một dòng rồi dùng `run_id` mở Run tương ứng. Liệt kê tất cả thông tin bạn biết về lượt đó chỉ từ hai nguồn này.
