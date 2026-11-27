# Open AgenticOS: kế hoạch code chi tiết

> 26/11/2026 · Bản nháp 1 · **Đã có phản biện: [OPEN-AGENTICOS-PLAN.PHAN-BIEN.md](OPEN-AGENTICOS-PLAN.PHAN-BIEN.md). Bản đó tìm ra nhiều chỗ sai trong tài liệu này; các sửa đổi nằm ở [tasks/SUA-SAU-PHAN-BIEN.md](tasks/SUA-SAU-PHAN-BIEN.md) và thắng tài liệu này.** · Thiết kế màn hình: `design-mockups/`.
> Tài liệu này nói cách biến AIOS-Lite hiện tại thành Open AgenticOS. Mọi dòng `file:dòng` đã được đối chiếu với code ngày 26/11/2026; chỗ nào chưa đối chiếu được ghi **CẦN KIỂM**.

Ký hiệu dùng trong bảng: **CÓ** = đã có trong repo, **SỬA** = sửa code đang có, **MỚI** = viết mới.

---

## 0. Đọc trước

### 0.1 Sản phẩm là gì

Một app chạy trên máy chủ shop. Mở ra là có sẵn: Hộp thư Zalo có bot chăm, đăng bài đa nền tảng, mini CRM, dashboard mạng xã hội và quảng cáo, và một brain là thư mục markdown mở được bằng Obsidian. Tầng agent là GenBot. Brain tồn tại để tạo vòng học: làm, đo, rút bài học, áp dụng.

### 0.2 Nguồn tham khảo và giấy phép

| Nguồn | Giấy phép | Được làm gì |
|---|---|---|
| `blogminhquy/javis-os` | MIT | Lấy ý tưởng: brain là file, một kho hội thoại, quyền chặn bằng code, tự học có commit git |
| `ZaloCRM` | AGPL-3.0 | `modules/zalo` đã chứa 12 file gốc từ đây (`modules/zalo/NOTICE`). Cả module là AGPL |
| `Freedombuiders/freedom_os` | "ClaudeClaw OS Community Commercial License", không phải mã nguồn mở | Chỉ tham khảo logic. Không chép code. Lưu ý `modules/*` của AIOS-Lite vốn được port từ đây, xem mục 9 |
| Plugin KISATO WHO 10X | Không kèm giấy phép | Chỉ lấy ý: xếp hạng 20% khách tốt nhất, tìm điểm chung |
| GenBot (`orca/genbot`) | `desktop/` là Apache-2.0; kế hoạch nội bộ ghi nguồn giữ kín | Dùng qua Bot API, không nhúng code |

### 0.3 Một từ chưa rõ

Chủ dự án nhắc "treg" ba lần như một công cụ lấy số liệu, ngang hàng với Apify và Composio. Không repo nào có công cụ tên vậy. Tài liệu này để chỗ cắm trống cho nó (mục 5.7.3) và không thiết kế gì dựa trên nó.

---

## 1. Đã chốt và chưa chốt

### 1.1 Đã chốt (chủ dự án đã nói rõ)

- Tầng agent là GenBot.
- Hộp thư chỉ chăm Zalo: xem lịch sử chat, chủ shop tự nhắn, gán bot để chăm. Không có gửi hàng loạt, không quét nhóm, không tính năng marketing Zalo.
- Khách hàng là mini CRM, dữ liệu lưu dạng ghi chú Obsidian.
- Có dashboard mạng xã hội, Facebook, YouTube, quảng cáo, và module quản lý quảng cáo.
- Có chế độ nói chuyện realtime.
- Brain phải tạo được vòng học cho bài viết và video.
- Có Dream 100: theo dõi tới 100 kênh, phân tích hằng ngày, đề xuất nội dung hằng ngày. Bài tạo ra phải lưu kèm công thức đã sinh ra nó để một bot so kết quả với công thức.

### 1.2 Chưa chốt (cần chủ dự án quyết trước khi code phần liên quan)

| # | Câu hỏi | Đề xuất của tài liệu này | Ảnh hưởng tới |
|---|---|---|---|
| Q1 | Sửa tại chỗ trong AIOS-Lite hay tách repo mới? | Sửa tại chỗ, theo nhánh | Mọi giai đoạn |
| Q2 | GenBot là runtime duy nhất hay mặc định? | **Đã quyết 27/11 (chủ): duy nhất.** "Chỉ dùng genbot agent, không dùng bot dạng khác." G1 ẩn các adapter cũ; G3 (27/11, "XOÁ CÁC LOẠI AGENT CŨ, CHỢ AGENT CŨ ĐI") xoá hẳn adapter claude/codex/grok/hermes, Chợ Agent và trang Agents chung. Chỉ còn `genbot` và `mock` (test, `AIOS_MOCK=1`); tên động cơ cũ chỉ còn trong `src/core/runtime-policy.ts` để nạp `agent.yaml` cũ và hiện mục "hãy chuyển sang GenBot". Đề xuất cũ: mặc định, giữ `claude`, `codex` làm dự phòng | P1 |
| Q3 | Ghi chú khách hàng là dữ liệu gốc hay bản chiếu từ SQLite? | Bản đầu: hai chiều có kiểm xung đột; file thắng với các trường kinh doanh | P3 |
| Q4 | Chấp nhận tên, số điện thoại khách nằm dạng chữ thường trong file? | Có, vì đó là cái giá của Obsidian. Hiện `care` mã hoá mọi cột `*_enc` | P3 |
| Q5 | Zalo AGPL: gói kèm hay cài riêng? | Lõi MIT; Zalo là module cài riêng lúc thiết lập, người dùng bấm đồng ý AGPL | P2, P9 |
| Q6 | Quản lý quảng cáo có được ghi lên Meta không? | Có, nhưng chỉ khi chủ bấm từng lần; cần quyền `ads_management` | P5 |
| Q7 | Model nói realtime nào? | Làm thử nghiệm kỹ thuật trước, chưa chọn | P8 |
| Q8 | "treg" là gì? | Chờ chủ dự án trả lời | P5, P7 |

---

## 2. Hiện trạng: cái gì đã có

Phần lớn nền đã có. Bảng dưới là lý do tài liệu này chủ yếu nói về sửa và nối, không phải viết lại.

| Màn trong thiết kế | Đã có ở đâu | Còn thiếu |
|---|---|---|
| Hộp thư Zalo, gán bot | `modules/care` (hộp thư, nháp, luật), `modules/zalo` (daemon `zca-js`) | Runtime GenBot; gửi ảnh khi tự nhắn; giao diện mới; tắt phần marketing |
| Bot chăm theo luật | `care/server/application/agent-turn.ts`, `policy/eligibility.ts` | Giới hạn độ dài prompt cho GenBot |
| Khách hàng, giai đoạn | `care_customers`, `care_profiles`, `care_tasks` | Ghi chú Obsidian; đơn hàng; xếp hạng |
| Đăng bài | `modules/marketing` (Facebook), `modules/kol/server/platforms` (Instagram, TikTok, YouTube) | Một màn soạn chung; ô chấm theo sổ bài học |
| Dashboard Facebook | `marketing/server/analytics/*`, bảng `fb_post_metrics`, `fb_page_daily` | Giao diện mới |
| Số liệu YouTube, Instagram, TikTok | `kol/server/metrics.ts`, bảng `kol_metrics`, `kol_account_daily` | Tách khỏi KOL Studio; màn riêng |
| Quảng cáo, luật đề xuất | `modules/ads` (`rules.ts`, `fb_ads_recommendations`) | Nút áp dụng (ghi lên Meta) |
| Brain | `src/shared/brain.ts`, `config/brain.yaml`, FTS5 | Ghi file qua API; đọc và ghi thuộc tính đầu file; theo dõi thay đổi; commit git; đồ thị |
| Quét kênh hằng ngày | `modules/radar` (Apify, RSSHub, lịch chạy bù 6 giờ) | Mô hình kênh và video cho Dream 100; tải video; công thức |
| Học từ video mẫu | Kỹ năng `modules/video/skills/video-learn` (`yt-dlp`, `ffmpeg`) | Chạy thành code theo lịch, không phải kỹ năng gõ tay |
| Hôm nay (hàng chờ duyệt) | `attention`, `web/src/pages/HomeDashboard.tsx:115-147` | Giao diện mới |
| Gọi trợ lý | Chưa có gì | Toàn bộ |
| Vòng học, sổ bài học | Chưa có gì | Toàn bộ |

---

## 3. Kiến trúc đích

```
Trình duyệt (Preact)  ──HTTP + SSE──►  Lõi AIOS (Hono, SQLite)
                                          │
        ┌─────────────────────────────────┼──────────────────────────────┐
        │                                 │                              │
   Module (care, zalo, marketing,    Runtime registry               brain/ (markdown)
   ads, radar, crm, learn, dream)    genbot (duy nhất)              chỉ mục: brain_docs + FTS5
        │                            · mock (test)                       ▲
        │                                 │                              │
   Zalo daemon :4381                 HTTP ► GenBot Bot API :8800    mọi module đọc, ghi qua
   Composio / Graph API              (luồng bị nhốt, chỉ chữ)        dịch vụ ghi chú (MỚI)
```

Bốn nguyên tắc, áp dụng cho mọi giai đoạn:

1. **Tri thức nằm trong file, vận hành nằm trong SQLite.** Khách hàng, bài đăng, công thức, bài học là ghi chú. Tin nhắn, hàng chờ gửi, nhật ký chạy là bảng. SQLite chỉ giữ thêm một chỉ mục dựng lại được từ file.
2. **Bot không tự gửi gì ra ngoài.** Tin Zalo đi qua `care_delivery_intents`. Bài đăng đi qua `fb_content` với `approval_required`. Lệnh ghi quảng cáo đi qua nút bấm của chủ.
3. **Quyền chặn bằng code.** Không dựa vào lời dặn trong prompt.
4. **Dữ liệu lấy từ mạng là không đáng tin.** Luôn bọc bằng `untrusted()` (`src/shared/context.ts:32-35`) trước khi vào prompt.

### 3.1 GenBot nối vào đâu

Bot API của GenBot (`genbot/desktop/docs/bot-api.md`) có các tính chất quyết định thiết kế:

- Gọi `POST /hooks/api/bots/<botId>/messages`, đầu `Authorization: Bearer <key>`, thân `{ message, thread?, wait? }`.
- `message` tối đa 20.000 ký tự. Thân tối đa 256 KB.
- Trả `200 {reply, thread}`, hoặc `202 {thread, status: "working" | "needs_approval"}`.
- Giới hạn 10 lượt gọi mỗi phút cho một khoá, 50 lượt đang chờ cùng lúc.
- Luồng mở qua API **bị nhốt**: không shell, không MCP, không ứng dụng, không công cụ nào. Bot chỉ trả lời bằng chỉ dẫn thường trực, bộ nhớ đã lưu và chính luồng đó.

Hệ quả: GenBot khớp gần như nguyên vẹn với lượt chạy `lean` của AIOS (không công cụ, một lượt). Vì thế cách nối đúng là **viết GenBot thành một runtime**, không phải viết một đường riêng cho `care`. Khi agent có `runtime: genbot`, mọi module đang gọi `ctx.agents.runLean` (care, marketing, ads, radar, kol) chạy qua GenBot mà không phải sửa.

Việc cần công cụ vẫn làm được mà không cần MCP: engine đã hiểu chỉ thị dạng chữ `<aios-action module= name=>` trong câu trả lời (`src/work/engine.ts:108-123`), có kiểm scope. Lưu ý lượt `lean` chỉ nhận chỉ thị `status` (`engine.ts:126-127`), nên việc cần hành động phải chạy ở lượt thường.

---

## 4. Cấu trúc brain

Đây là hợp đồng dữ liệu. Mọi module ghi vào brain phải theo đúng.

### 4.1 Cây thư mục

```
brain/<cong-ty>/
  ho-so.md                  chủ viết
  giong-noi.md              chủ viết
  san-pham/                 chủ viết, bot chỉ đọc
  chinh-sach/               chủ viết, bot chỉ đọc
  khach-hang/<slug>.md      1 khách = 1 ghi chú          (P3)
  khach-hang/_chan-dung-khach-tot.md
  noi-dung/bai/<ngay>-<slug>.md      1 bài đã đăng       (P6)
  noi-dung/de-xuat/<ngay>.md         đề xuất mỗi ngày    (P7)
  bai-hoc/<slug>.md         1 bài học                    (P6)
  cong-thuc/<slug>.md       1 công thức                  (P7)
  dream-100/kenh/<slug>.md  1 kênh                       (P7)
  dream-100/video/<ngay>-<kenh>-<id>.md  1 video nổi bật (P7)
  tong-ket/<nam>-tuan-<so>.md                            (P6)
  nho/MEMORY.md
```

Mỗi công ty là một mục trong `config/brain.yaml`. Quyền theo thư mục cho từng agent đã có sẵn: `access.brain.<folder>.{read,write}` là danh sách glob (`src/core/types.ts:12-15`, `src/access/policy.ts:24-33`).

### 4.2 Thuộc tính đầu file

Mọi ghi chú do máy tạo có khối YAML ở đầu. Tên khoá viết thường không dấu, nối bằng gạch dưới. Trường `loai` là bắt buộc và quyết định bộ kiểm tra.

```yaml
# khach-hang/chi-lan.md
loai: khach-hang
id: cus_01J...            # khoá nối với care_customers.id, không được sửa tay
ten: Chị Lan
sdt:
zalo: chua-ket-ban        # ban-be | chua-ket-ban
nguon: Bài đăng "Trà sen Tây Hồ"
giai_doan: dang-tu-van    # moi | dang-tu-van | da-bao-gia | dat-coc | da-chot | mat
the: [hoi-si, o-long-sen, co-cua-hang]
gia_tri: 14352000
da_mua: 0
hang:                     # A | B | C, máy ghi
viec_tiep: Hỏi lại sau khi gửi báo giá
han: 2026-11-28
cap_nhat: 2026-11-26T09:44:00+07:00
```

```yaml
# noi-dung/bai/2026-11-24-uop-tra-sen.md
loai: bai-dang
id: fbc_...               # fb_content.id hoặc khoá của kol
cong_thuc: "[[huong-dan-3-buoc]]"     # bắt buộc nếu bài sinh từ đề xuất
hoc_tu: "[[2026-11-23-bep-nha-moc-7301]]"
nen_tang: facebook
dinh_dang: video-ngan     # video-ngan | anh | chu | album
tru_cot: cach-pha-uop     # bot gắn
mo_dau: cau-hoi           # cau-hoi | con-so | ten-san-pham | cau-chuyen | chi-loi-sai
do_dai: 38
dang_luc: 2026-11-24T19:00:00+07:00
reach: 6200
er: 7.1
tb_xem: 21
so_voi_ky_vong: 1.08      # Bot Đối chiếu ghi
moc_da_do: [1h, 6h, 24h]
```

```yaml
# cong-thuc/huong-dan-3-buoc.md
loai: cong-thuc
mo_dau: cau-hoi
cau_truc: 3-buoc
do_dai_toi_da: 45
cat_moi_phut: 14
ky_vong: 1.5              # gấp mấy lần trung vị kênh mình, đặt lúc rút công thức
bang_chung: 9             # số video Dream 100
da_lam: 5                 # số bài của mình
ket_qua: 1.57             # ER trung vị các bài của mình chia trung vị kênh
trang_thai: hop           # chua-thu | co-ve-hop | hop | chua-hop
```

```yaml
# bai-hoc/video-huong-dan-ngan.md
loai: bai-hoc
mang: noi-dung            # noi-dung | cham-khach | quang-cao
trang_thai: da-kiem-chung # gia-thuyet | dang-thu | da-kiem-chung | bi-bac-bo
bang_chung: ["[[2026-11-24-uop-tra-sen]]", "[[2026-11-19-o-long-lanh]]"]
dung_boi: [bot-noi-dung]
```

`dream-100/kenh/*` có `loai: kenh-dream`, `nen_tang`, `link`, `hoc_gi`, `trung_vi_xem`, `lay_bang`. `dream-100/video/*` có `loai: video-dream`, `kenh`, `luot_xem`, `gap_trung_vi`, `mo_dau`, `do_dai`, `cat_moi_phut`, `cong_thuc`.

### 4.3 Luật ghi

- Chỉ dịch vụ ghi chú (mục 5.0.2) được ghi file. Module không tự `fs.writeFile`.
- Ghi đè chỉ đụng các khoá module đó sở hữu; phần thân do người viết phải giữ nguyên.
- Nội dung lấy từ mạng (tên video, mô tả) vào thân ghi chú phải được coi là dữ liệu, không là chỉ dẫn. Khi ghi chú đó vào prompt, nó đi qua `untrusted()` như mọi kết quả tìm brain.
- Không lưu lời thoại, hình, nhạc của kênh khác. Chỉ lưu số đo và mô tả cấu trúc.

---

## 5. Các giai đoạn

Thứ tự đề xuất: P0 → P1 → P2 → P4 → P3 → P5 → P6 → P7 → P8 → P9. P4 (giao diện) có thể chạy song song với P1 và P2.

### 5.0 P0: nền cho ghi chú

Mọi giai đoạn sau đều ghi và đọc ghi chú có thuộc tính, nên phải làm trước.

#### 5.0.1 Việc phải làm

| # | Việc | File | Loại |
|---|---|---|---|
| 1 | Tách `parseFrontmatter` ra dùng chung, thêm hàm ghi | `src/teams/package.ts:37-42` → `src/shared/frontmatter.ts` | SỬA |
| 2 | Dịch vụ ghi chú có kiểm kiểu theo `loai` | `src/shared/notes.ts` | MỚI |
| 3 | Thêm `PUT /api/brain/file` | `src/api/routes/brain.ts` (hiện chỉ có `GET` ở dòng 53, trong khi `web/.../BrainNoteEditor.tsx:72` đã gọi `PUT`) | SỬA |
| 4 | Theo dõi thay đổi file | `src/shared/brain-watch.ts`, gọi trong `src/main.ts:133-143` | MỚI |
| 5 | Commit git cho mỗi lần máy ghi | `src/shared/brain-git.ts` | MỚI |
| 6 | Mở `ctx.brain` cho module: thêm `read`, `write`, `notes` | `src/modules/sdk.ts:78-167`, `src/modules/context.ts` | SỬA |
| 7 | Kiểm quyền ghi theo glob trước khi ghi | dùng `pathAllowed` (`src/access/policy.ts:99-107`), hiện chưa có nơi nào gọi | SỬA |

#### 5.0.2 Hợp đồng

```ts
// src/shared/frontmatter.ts
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string; has: boolean };
/** Giữ nguyên thứ tự khoá đang có; khoá mới thêm vào cuối. Không đụng phần thân. */
export function writeFrontmatter(text: string, patch: Record<string, unknown>): string;

// src/shared/notes.ts
export interface NoteRef { folderId: string; relPath: string }
export interface Note<T = Record<string, unknown>> extends NoteRef { data: T; body: string; mtimeMs: number }
export interface NotesService {
  read<T>(ref: NoteRef): Note<T> | undefined;
  /** Ghi các khoá trong patch. expectMtimeMs lệch thì ném NoteConflictError. */
  patch(ref: NoteRef, patch: Record<string, unknown>, opts: { actor: string; expectMtimeMs?: number; message: string }): Note;
  create(ref: NoteRef, data: Record<string, unknown>, body: string, opts: { actor: string; message: string }): Note;
  list<T>(folderId: string, dir: string, filter?: { loai?: string }): Note<T>[];
  /** Ghi chú trỏ tới ghi chú này qua [[liên kết]]. */
  backlinks(ref: NoteRef): NoteRef[];
}
```

- Kiểu của từng `loai` là một lược đồ zod trong `src/shared/note-schemas.ts`. `patch` và `create` từ chối dữ liệu sai lược đồ.
- `actor` là `owner`, `system`, hoặc id agent. Với id agent, dịch vụ kiểm quyền ghi theo glob trước khi ghi.
- Mỗi lần ghi thành công gọi `brain.reindex({ folderId })` cho file đó và, nếu thư mục brain là một kho git, commit với lời nhắn `message`. Thư mục chưa là kho git thì bỏ qua bước commit và ghi một dòng log; không tự `git init`.
- Liên kết `[[...]]` được trích lúc lập chỉ mục vào bảng lõi mới `brain_links(src_path, dst_slug, folder_id)`. Bảng này cũng là nguồn cho màn Đồ thị.

#### 5.0.3 Theo dõi thay đổi

Hiện brain chỉ lập chỉ mục lại lúc khởi động và mỗi 15 phút (`src/main.ts:133-143`). Người sửa trong Obsidian sẽ phải chờ tới 15 phút. Thêm `chokidar` theo dõi các thư mục trong `brain.yaml`, gộp sự kiện trong 500 ms rồi gọi `reindex({ folderId })`. Phát sự kiện `brain:changed` qua bus để giao diện và các module đồng bộ (P3) nghe.

#### 5.0.4 Xong khi

- `PUT /api/brain/file` ghi được, trả 409 khi `mtime` lệch, từ chối đường dẫn thoát khỏi thư mục.
- Sửa một file trong Obsidian, tìm kiếm thấy nội dung mới trong vòng 2 giây.
- Ghi qua `NotesService` tạo đúng một commit; `git revert` commit đó khôi phục file.
- Test: `src/shared/frontmatter.test.ts`, `notes.test.ts` dùng `tmpDir`, `sampleBrain` trong `src/shared/test-kit.ts`.

---

### 5.1 P1: runtime `genbot`

#### 5.1.1 Cấu hình một agent chạy trên GenBot

`agent.yaml` đã có `runtime_options` kiểu bản ghi tự do (`src/agents/schema.ts:38`), nên không cần sửa lược đồ:

```yaml
name: Bot CSKH
runtime: genbot
context: lean
runtime_options:
  base_url: http://127.0.0.1:8800     # cổng nhận webhook của GenBot
  bot_id: bot_abc123
  key_env: GENBOT_KEY_CSKH            # tên biến môi trường chứa khoá Bot API
access:
  brain: { tra-sen-viet: { read: ["san-pham/**", "chinh-sach/**", "giong-noi.md"], write: [] } }
  modules: { care: ["reply.send"] }
```

Khoá nằm trong `.env`, cùng chỗ với `COMPOSIO_API_KEY`. Không bao giờ ghi khoá vào `agent.yaml`.

#### 5.1.2 Các chỗ phải thêm id `genbot`

Bài học `docs/lessons/04-them-runtime-moi.md` chỉ liệt kê hai chỗ ở giao diện và đã lỗi thời. Danh sách đủ:

| File | Dòng | Việc |
|---|---|---|
| `src/core/types.ts` | 3-4 | Thêm vào `RuntimeId` và `RUNTIME_IDS` |
| `src/runtimes/genbot.ts` | mới | Bộ chuyển |
| `src/runtimes/index.ts` | 3-8, 14 | Đăng ký |
| `src/modules/compat/provider.ts` | 26 | `BY_RUNTIME` |
| `src/work/engine.ts` | 190 | Không nối skill cho `genbot` (giữ nguyên, chỉ kiểm lại) |
| `web/src/lib/labels.ts` | 3-9 | `RUNTIME_LABEL` |
| `web/src/lib/teams.ts` | 4 | `RUNTIMES` |
| `web/src/pages/agents/AgentsPage.tsx` | 23 | `TONE` |
| `web/src/components/costs/format.ts` | 4 | `RUNTIME_COLORS` |
| `modules/video/server/edit/turn.ts` | 9-10 | `RUNTIME_PROVIDER`, `RUNTIME_LABEL` |
| `src/runtimes/index.test.ts` | 9, 59-60 | Danh sách mong đợi |

Các chỗ dùng `RUNTIME_IDS` (`src/agents/schema.ts:36`, `src/api/routes/agents.ts:10`, `teams.ts:13`, `teams/install.ts:138`, `teams/package.ts:209`) tự cập nhật. (Ghi chú G3: Chợ Agent `src/agent-market/` đã bị xoá; nay các chỗ này dùng `KNOWN_RUNTIME_NAMES` của `src/core/runtime-policy.ts`.)

#### 5.1.3 Bộ chuyển

```ts
// src/runtimes/genbot.ts
export const GENBOT_CAPABILITIES: RuntimeCapabilities = {
  resume: false,            // bản đầu: mỗi lượt một luồng mới, xem 5.1.5
  systemPrompt: 'inline',   // Bot API không có ô system prompt
  reportsCost: false,
  images: false,
  documents: false,
  noTools: true,
  enforces: {
    context: 'hard', mcp: 'hard', fileRead: 'hard', fileWrite: 'hard', shell: 'hard',
    note: 'Luồng Bot API của GenBot bị nhốt: không công cụ, không MCP, không đọc ghi file.',
  },
};
```

`run(req)` làm theo thứ tự:

1. Đọc `base_url`, `bot_id`, `key_env` từ `req.agent.runtimeOptions`. Thiếu cái nào thì trả `{ ok: false, error: { family: 'config', ... } }`.
2. Ghép `message = req.systemPrompt + "\n\n" + req.prompt`. Dài hơn 20.000 ký tự thì trả lỗi `config` với lời nhắn nêu rõ độ dài. Không tự cắt, vì bộ chuyển không biết phần nào quan trọng.
3. Xin một lượt từ bộ giới hạn 10 lượt mỗi phút cho từng khoá (giữ trong bộ nhớ, theo `key_env`). Hết lượt thì chờ; chờ quá `timeoutMs` thì trả `quota` kèm `retryAfter`.
4. `POST` với `wait = min(120, floor(timeoutMs / 1000))`. Nối `req.signal` vào `fetch`.
5. Đổi kết quả theo bảng dưới.

| GenBot trả | `RunResult` |
|---|---|
| `200 {reply, thread}` | `ok: true`, `output: reply` |
| `202 working` | Hỏi lại `GET …/messages?thread=<id>` mỗi 2 giây tới khi có trả lời hoặc hết `timeoutMs` (hết giờ: `timeout`) |
| `202 needs_approval` | `ok: false`, `family: 'access'`, lời nhắn "Bot GenBot đang chờ bạn duyệt trong app GenBot" |
| `400`, `413`, `415` | `config` |
| `401` | `auth` |
| `403` | `config` (Bot API đang tắt cho bot này, hoặc AI của bot không chạy nhốt được) |
| `404`, `409` | `transient` |
| `429` | `quota`, `retryAfter` = 60 giây sau |
| `502` | `unknown` |
| lỗi mạng | `transient` |
| `signal` bị huỷ | `cancelled` |

`usage` luôn để trống. Không điền số 0 (`contracts.ts`: "missing fields = unknown").

**CẦN KIỂM** trước khi viết bước 202: dạng trả về của `GET …/messages?thread=` không có trong tài liệu, phải đọc `genbot/desktop/server/bot-api-host.ts`.

`doctor()`: không `probe` thì kiểm đủ cấu hình và thử kết nối TCP tới `base_url`. Có `probe` thì gửi một tin "ping" thật và đòi `200`.

#### 5.1.4 Hai hệ quả phải xử lý

- **Ngân sách không có tác dụng.** `runs.monthCost` chỉ cộng `cost_usd` khác rỗng (`src/work/runs.ts:77-82`), nên runtime không báo chi phí sẽ không bao giờ bị chặn ngân sách. Thêm trần số lượt chạy mỗi ngày cho agent: `runtime_options.max_runs_day` (mặc định 500), kiểm ở `engine.ts` ngay cạnh chỗ kiểm ngân sách (dòng 178), trả `family: 'budget'`.
- **Lượt thường cũng không có công cụ.** `policy.ts:67-77` cấp cầu MCP `aios-integrations` cho mọi lượt không `lean`. Với `genbot` cầu này vô dụng. Sửa `policy.ts` để bỏ qua khi `runtime.capabilities.noTools` là thật và runtime không nhận MCP, và hiện dòng `enforces.note` trên tab Quyền.

#### 5.1.5 Luồng GenBot và trí nhớ hội thoại

Bản đầu không nối tiếp luồng: mỗi lượt mở một luồng mới, AIOS tự gửi đủ ngữ cảnh. Lý do: `RunRequest` không mang khoá hội thoại nào ngoài `sessionId`, và lượt `lean` của module không có hội thoại lõi để gắn phiên.

Cái giá: app GenBot sẽ có rất nhiều luồng ngắn, và có thể chạm trần "số cuộc trò chuyện cùng lúc" (`409`). Bản sau: thêm `sessionKey?: string` vào `LeanRunInput` (`src/modules/sdk.ts:52-76`), lõi giữ bảng `runtime_sessions(runtime, agent_id, session_key, session_id)`, và `care` truyền `sessionKey = conversationId`.

#### 5.1.6 Test

- `test-fixtures/runtimes/fake-genbot.mjs`: máy chủ `node:http` giả, điều khiển bằng biến môi trường để trả 200, 202 rồi 200, 202 `needs_approval`, 429, 401.
- `src/runtimes/genbot.test.ts` dùng `makeReq`, `tmpCwd` trong `src/runtimes/test-util.ts`. Phải có ca: đủ bảng mã lỗi ở trên, prompt quá 20.000 ký tự, huỷ giữa chừng, giới hạn 10 lượt mỗi phút.

#### 5.1.7 Xong khi

- Một agent `runtime: genbot` trả lời được ở `/chat` và ở lượt `lean` của `care`.
- `GET /api/runtimes` hiện `genbot` với kết quả `doctor`.
- `npm run typecheck` và `npx vitest run src/runtimes` qua.
- Cập nhật `docs/dev/runtime-verification.md` và sửa bài học 04.

---

### 5.2 P2: Hộp thư Zalo, chỉ chat và gán bot

#### 5.2.1 Luồng đã có (không viết lại)

1. Daemon Zalo là tiến trình riêng, giữ mọi kết nối, mở cổng điều khiển ở `127.0.0.1:4381` (`modules/zalo/server/daemon.ts`, `supervisor.ts`).
2. `care` **kéo** tin về: việc `sync_poll` chạy mỗi 60 giây, gọi `ZaloCareConnector.sync` (`care/server/runtime/handlers.ts:126-200`, `care-runtime.ts:256`).
3. `CareIngestPipeline.ingestNormalizedEvent` lưu tin, tự tạo khách, rồi xếp việc `inbound_turn` nếu đủ điều kiện (`care/server/application/ingest.ts:114`, `:445-500`).
4. `CareAgentTurn.run` dựng ngữ cảnh, gọi `ctx.agents.runLean`, đọc JSON trả về, rồi tạo nháp hoặc xếp hàng gửi (`application/agent-turn.ts:205`).
5. Nháp là một dòng `care_delivery_intents` có `status='draft'`. Chủ bấm duyệt thì `draft → pending`, việc `outbox_dispatch` chạy mỗi 2 giây sẽ gửi.

Bot GenBot phải trả đúng lược đồ mà `care` đang đòi (`application/agent-output.ts:7-9`), thừa một khoá là bị từ chối cả câu trả lời:

```json
{"action":"reply","replies":[{"ref":"m3","text":"..."}],"needsReview":false,"reason":"..."}
{"action":"skip","reason":"..."}
{"action":"handoff","reason":"..."}
```

Lược đồ này đã nằm trong prompt do `buildAgentPrompt` dựng (`agent-turn.ts:135-184`). Chỉ dẫn thường trực của bot trong GenBot chỉ nên nói về giọng điệu, không lặp lại lược đồ.

#### 5.2.2 Ánh xạ màn thiết kế sang cái đã có

| Trên màn | Trong code |
|---|---|
| Chọn bot cho cả nick | `care_assignments` với `scope='account'`, `agent_id` |
| Đặt riêng cho một cuộc chat | `care_assignments` với `scope='conversation'`, hoặc `care_conversation_state.ai_mode` |
| Tự trả lời / Soạn nháp / Tắt bot | `mode` = `auto` / `draft` / `observe`; ghi đè từng cuộc chat qua `PUT /conversations/:id/ai` (`api/routes-workflow.ts:79-91`) |
| Bạn tự nhắn thì bot nhường 30 phút | Đã có: cửa sổ tạm dừng Zalo 30 phút (`policy/policy-ext.ts:62`) |
| Tối đa 30 câu mỗi khách mỗi ngày | Đã có (`policy-ext.ts:61`) |
| Chờ 3 đến 12 giây | Đã có, nhưng cài đặt module `autoDelaySeconds = 10` đang ghi đè (`module-runtime.ts:156-159`) |
| Chỉ trả lời tin chữ | Đã có |
| Khách đòi gặp người thì dừng | **Chưa có dạng cứng.** Hiện chỉ là lời dặn trong prompt; "handoff" chỉ nêu việc cần chú ý (`agent-turn.ts:153-155`) |
| Dừng 30 phút, 2 giờ, đến khi bật lại | Cột `is_paused`, `paused_until` có trong `care_conversations`. **CẦN KIỂM** đã có API đặt hai cột này chưa |

#### 5.2.3 Việc phải làm

| # | Việc | File | Loại |
|---|---|---|---|
| 1 | Giới hạn độ dài ngữ cảnh khi agent chạy trên GenBot | `care/server/application/agent-context.ts:32-36` | SỬA |
| 2 | Luật cứng cho từ khoá đòi gặp người | `care/server/policy/text-heuristics.ts`, `eligibility.ts` | SỬA |
| 3 | Tự nhắn kèm ảnh, file | `care/server/application/outbox-service.ts:46-67`, `connectors/zalo/zca-transport.ts:191` | SỬA |
| 4 | Tắt phần marketing của Zalo theo mặc định | `modules/zalo/module.json:36-40`, `web/index.tsx:30-40` | SỬA |
| 5 | Gỡ phụ thuộc lõi chat vào marketing | `modules/zalo/server/ingest.ts:28` (đang import `birthday.ts`) | SỬA |
| 6 | Màn Hộp thư mới | `modules/care/web/pages/…` | SỬA |
| 7 | Hiện số tin đã gửi trên trần | lấy từ `modules/zalo/server/limits.ts` | SỬA |

Chi tiết:

**Việc 1.** Ngữ cảnh của `care` hiện tới 30 tin, mỗi tin tới 2.000 ký tự. Trường hợp xấu nhất là 60.000 ký tự, cộng thêm 4.000 ký tự brain của lượt `lean` (`src/shared/contracts.ts:134-137`). GenBot chỉ nhận 20.000. Thêm tham số `maxChars` cho `buildAgentContext`; khi runtime của agent là `genbot` thì đặt 12.000 và cắt từ tin cũ nhất. Không cắt tin mới nhất của khách.

**Việc 2.** Thêm danh sách cụm từ ("gặp nhân viên", "gặp người thật", "khiếu nại") thành cài đặt module. Tin của khách khớp thì: không gọi agent, đặt `paused_until = now + 60 phút`, gọi `ctx.attention.raise`. Kiểm ở `eligibility.ts` trước khi xếp việc, để không tốn một lượt gọi GenBot.

**Việc 3.** `zalo/server/sender.ts:364` đã gửi được album ảnh và file, nhưng đường của `care` cố ý để `sendMedia: []`. Mở cho `actor='manual'`; giữ khoá với `actor='auto'` và `'approved'`. Tải file lên qua `media.ts` sẵn có.

**Việc 4 và 5.** Đặt `marketingEnabled` mặc định là `false`. Các worker marketing đã nằm sau cài đặt này (`daemon.ts:121-134`). Ẩn mục menu khi cài đặt tắt. Tách lời gọi sinh nhật trong `ingest.ts` thành một hàm được tiêm vào, chỉ tiêm khi `marketingEnabled` bật. Không xoá file marketing ở bản này, để khác biệt với bản gốc nhỏ và dễ gộp sửa lỗi.

**Việc 7.** Trần của module là 1.000 tin mỗi ngày và 20 tin mỗi 30 giây cho một nick, kèm lịch làm nóng nick `[30, 80, 150]` theo tuần (`limits.ts:55-65`, `store.ts:687-695`). Màn thiết kế đang ghi "46/200" theo mặc định của ZaloCRM gốc; khi code phải lấy số thật từ `limits.ts`.

#### 5.2.4 Chưa làm ở bản này

- Thả cảm xúc: connector khai `reaction: false` (`zalo-connector.ts:248`).
- Thu hồi tin từ phía mình.
- Trạng thái kết bạn: chưa có ở lõi chat. Màn thiết kế có hiện "Chưa kết bạn"; cần thêm đọc trạng thái từ `zca-js` vào `care-profiles.ts`. **CẦN KIỂM** `zca-js` 2.1.2 trả trường nào.
- Đánh dấu đã xem phía Zalo đang tắt, chỉ bật bằng `ZALO_CARE_SEEN` (`daemon.ts:111-112`). Giữ tắt.

#### 5.2.5 Xong khi

- Quét QR, tin Zalo mới hiện ở Hộp thư trong 60 giây.
- Gán một agent `runtime: genbot` cho nick; khách nhắn một câu có trong brain, nháp xuất hiện; bấm duyệt, khách nhận được tin.
- Khách nhắn "cho gặp nhân viên": không có lượt gọi GenBot nào, cuộc chat tạm dừng 60 phút, Hôm nay có một mục mới.
- Ngữ cảnh 30 tin dài vẫn gửi được qua GenBot (không lỗi 20.000 ký tự).
- Menu không còn mục gửi hàng loạt, sinh nhật, mẫu tin.
- `npx vitest run modules/care modules/zalo` qua.

---

### 5.3 P3: Khách hàng dạng ghi chú

#### 5.3.1 Quyết định thiết kế

`care` hiện là chủ của dữ liệu khách: `care_customers` với các cột mã hoá, có `revision`, và `care_identities` nối khách với tài khoản Zalo. Viết lại `care` (khoảng 24.000 dòng) để đọc từ file là rủi ro lớn. Tài liệu này đề xuất một module mới đứng cạnh, đồng bộ hai chiều.

- **File thắng** với các trường kinh doanh: `ten`, `sdt`, `nguon`, `giai_doan`, `the`, `gia_tri`, `viec_tiep`, `han`, và toàn bộ phần thân.
- **SQLite thắng** với: `id`, liên kết danh tính Zalo, lịch sử tin nhắn.
- **Máy ghi, người không sửa:** `hang`, `da_mua`, `cap_nhat`.

#### 5.3.2 Module `crm`

```
modules/crm/
  module.json            id: crm, category: sales, requires.modules: [care]
  migrations/001_init.sql
  server/index.ts        defineModule
  server/sync.ts         đồng bộ hai chiều
  server/score.ts        xếp hạng
  server/portrait.ts     điểm chung của nhóm A
  web/…                  Giai đoạn, Tất cả khách, Hồ sơ, Khách tốt nhất
```

```sql
CREATE TABLE crm_note_index (
  customer_id TEXT PRIMARY KEY,
  folder_id   TEXT NOT NULL,
  rel_path    TEXT NOT NULL UNIQUE,
  note_mtime  INTEGER NOT NULL,     -- mtime của file lần đồng bộ gần nhất
  db_revision INTEGER NOT NULL,     -- care_customers.revision lần đồng bộ gần nhất
  data_hash   TEXT NOT NULL
);
CREATE TABLE crm_orders (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL,
  amount INTEGER NOT NULL, ordered_at INTEGER NOT NULL,
  due_at INTEGER, paid_at INTEGER, note TEXT
);
CREATE TABLE crm_scores (
  customer_id TEXT PRIMARY KEY,
  revenue REAL, on_time REAL, referral REAL, ease REAL,
  total REAL, rank TEXT, computed_at INTEGER NOT NULL
);
CREATE TABLE crm_sync_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT, field TEXT,
  note_value TEXT, db_value TEXT, at INTEGER NOT NULL, resolved INTEGER DEFAULT 0
);
```

`care` phải mở một API cho module khác: thêm vào `provides` của `care` một dịch vụ `customers` với `list()`, `get(id)`, `update(id, patch, expectRevision)`, và phát sự kiện `care:customer.changed`. **CẦN KIỂM** `modules/care/server/index.ts` đã `provides` gì.

#### 5.3.3 Thuật toán đồng bộ

- **Từ SQLite ra file:** nghe `care:customer.changed`. Nếu `revision` mới hơn `db_revision` thì `notes.patch` các khoá do SQLite sở hữu, và các khoá kinh doanh **chỉ khi** file chưa đổi kể từ `note_mtime`.
- **Từ file vào SQLite:** nghe `brain:changed` cho `khach-hang/*.md`. Đọc thuộc tính, kiểm lược đồ. Nếu lược đồ sai thì không đồng bộ, nêu một mục cần chú ý kèm tên file. Nếu đúng thì `customers.update(id, patch, db_revision)`.
- **Xung đột** (cả hai bên cùng đổi một trường): file thắng với trường kinh doanh, ghi một dòng `crm_sync_conflicts`, và nêu một mục cần chú ý.
- **File mới không có `id`:** tạo khách mới trong `care`, rồi ghi `id` vào file.
- **File bị xoá:** không xoá khách. Đánh dấu và hỏi chủ.
- **Tên file:** bỏ dấu tên khách, viết thường, nối gạch ngang. Trùng thì thêm `-2`, `-3`. Đổi tên khách không đổi tên file.

#### 5.3.4 Xếp hạng

Bốn tiêu chí, mỗi tiêu chí 0 đến 10, trọng số 40, 20, 25, 15. Trọng số là cài đặt module.

| Tiêu chí | Cách tính |
|---|---|
| Doanh thu | Tổng `crm_orders.amount`, quy về 0–10 theo nhỏ nhất và lớn nhất trong nhóm đã mua |
| Trả đúng hạn | Theo số đơn trả sau `due_at`: 0 lần → 10, 1 → 6, 2 → 3, từ 3 → 0 |
| Giới thiệu | Số khách có `nguon` trỏ tới khách này: 0 → 0, 1 → 5, 2 → 8, từ 3 → 10 |
| Dễ phục vụ | Chủ chấm tay |

Nhóm A là 20% đứng đầu, B là 30% kế tiếp, còn lại C. Chỉ xếp khách có ít nhất một đơn.

Lưu ý quan trọng: **hiện không có dữ liệu đơn hàng ở đâu cả**. `care` chỉ có `stage='won'`. Bản đầu phải có nút "Ghi nhận đơn" nhập tay vào `crm_orders`. Chưa có đơn thì màn Khách tốt nhất hiện trạng thái trống, không hiện số bịa.

#### 5.3.5 Điểm chung của nhóm A

`portrait.ts` chạy khi chủ bấm, hoặc mỗi tuần. Gửi cho agent (lượt `lean`) thuộc tính và phần "Khách cần gì" của từng khách, đã bọc `untrusted`, chia hai nhóm A và còn lại. Đòi JSON `{ traits: [{ text, inA: string[], inRest: string[] }] }`. Code tự đếm lại tỷ lệ từ danh sách id trả về, không tin con số agent tự nêu. Ghi kết quả vào `khach-hang/_chan-dung-khach-tot.md`. Nhóm A dưới 5 khách thì ghi chú phải kèm dòng "giả thuyết".

#### 5.3.6 Xong khi

- Khách mới từ Zalo có file trong 5 giây.
- Đổi `giai_doan` trong Obsidian, bảng Giai đoạn trong app đổi theo trong 2 giây.
- Hai bên cùng sửa một trường: file thắng, có một mục cần chú ý.
- File có thuộc tính sai kiểu không làm hỏng dữ liệu trong SQLite.
- Xếp hạng tính lại khi thêm đơn; tổng trọng số khác 100 bị từ chối.

---

### 5.4 P4: giao diện mới

Giữ nguyên bộ khung Preact, wouter, Tailwind 4. Chủ đề tối đã là mặc định (`web/src/styles/main.css`, khối `@theme`).

| # | Việc | File |
|---|---|---|
| 1 | Sắp lại thanh bên thành: Hôm nay, Gọi trợ lý, Trò chuyện; Brain; Chăm khách; Marketing; Đội AI và hệ thống | `web/src/lib/nav.ts` (`CORE_NAV`, `GROUP_LABEL`, `GROUP_ORDER`) |
| 2 | Thêm nhóm menu cho module | `NavGroup` ở `web/src/module-host/contracts.ts:6`, và `category` ở `src/modules/loader.ts:18-35` |
| 3 | Thanh ra lệnh cố định dưới đáy | thành phần mới trong khung, gửi tới API trò chuyện đang có (`docs/dev/API.md`) |
| 4 | Màn Hôm nay | sửa `web/src/pages/HomeDashboard.tsx`; phần "AI đã tự làm" đọc từ `runs` |
| 5 | Màn Đồ thị | trang mới, đọc `brain_docs` và `brain_links` (P0) |
| 6 | Ẩn các mục lõi không dùng ở bản gọn | Gói Team, Skills vào một mục "Nâng cao" (G3 đã xoá Chợ Agent và trang Agents chung: `/agent-market`, `/agents` chuyển về `/bots`) |

Mỗi module tự đăng ký trang qua `defineWebModule` như hiện nay. Khung không biết tên module nào.

**Xong khi:** mọi trang cũ vẫn mở được; bật, tắt một module thì menu đổi theo mà không cần tải lại bản dựng; chạy `npm run build` không lỗi kiểu.

---

### 5.5 P5: dashboard mạng xã hội và quảng cáo

#### 5.5.1 Mạng xã hội

Số liệu Facebook đã có đủ: `fb_post_metrics` (khoá `(post_id, milestone)`, mốc 1 giờ, 6 giờ, 24 giờ, 3 ngày, 7 ngày, 28 ngày), `fb_page_daily`, `fb_insights`, và các phép tính trong `marketing/server/analytics/metrics.ts` (ER = (cảm xúc + bình luận + chia sẻ) ÷ reach × 100).

Số liệu YouTube, Instagram, TikTok của tài khoản mình đã được đọc mỗi 30 phút trong `kol/server/metrics.ts`, ghi `kol_metrics` và `kol_account_daily`. Vấn đề: nó nằm trong module KOL Studio, vốn không thuộc bản gọn.

Việc phải làm:

1. Tách phần đọc số liệu kênh ra `modules/_lib/social-stats/` (hàm thuần, nhận `execute` của Composio).
2. Module mới `social`: `requires.modules: [marketing]`, tự chạy phần đọc số liệu đó bằng `ctx.schedule.every`, có bảng riêng `social_account_daily`, `social_video_stats`.
3. Ba trang: Tổng quan, Facebook, YouTube. Trang Facebook gọi API phân tích sẵn có của `marketing`.

Giới hạn phải ghi lên màn: YouTube ở kết nối này chỉ có số công khai của kênh và từng video (`YOUTUBE_GET_CHANNEL_STATISTICS`, `YOUTUBE_GET_VIDEO_DETAILS_BATCH`). Không có giờ xem, tỷ lệ giữ chân, hay chuỗi theo ngày.

#### 5.5.2 Quảng cáo

`modules/ads` đã đọc số liệu qua năm lệnh GET, chụp mỗi 55 phút, và có máy luật R1 đến R5 ghi vào `fb_ads_recommendations`. **Nó không ghi gì lên Meta** (`rules.ts:3`, `worker.ts:4`), và chỉ xin quyền `ads_read,business_management` (`accounts.ts:188`).

Thêm nút áp dụng:

| # | Việc | File |
|---|---|---|
| 1 | Cài đặt `writeEnabled` (mặc định tắt) và xin thêm quyền `ads_management` khi bật | `modules/ads/module.json`, `server/accounts.ts:188` |
| 2 | Hai lệnh ghi: tạm dừng chiến dịch hoặc nhóm quảng cáo; đổi ngân sách ngày | `server/graph-tools.ts` (thêm lệnh POST qua `graphProxy`) |
| 3 | Đường áp dụng | `POST /api/m/ads/recommendations/:id/apply` |
| 4 | Rào cứng | xem dưới |

Rào cứng, kiểm trong code của đường áp dụng:

- Chỉ chạy từ một yêu cầu HTTP của chủ. Không đăng ký thành `ModuleAction`, để agent không gọi được.
- Tăng ngân sách tối đa 20% mỗi lần, và không quá một lần trong 3 ngày cho một nhóm quảng cáo.
- Trước khi ghi, đọc lại trạng thái mới nhất từ Meta; nếu đề xuất dựa trên số liệu cũ hơn 2 giờ thì từ chối và chụp lại.
- Ghi `ctx.audit.log` với giá trị trước và sau.

Ngưỡng luật "Tăng 20%" trong `rules.ts` đòi từ 50 kết quả mỗi tuần. Với shop nhỏ ngưỡng này gần như không bao giờ đạt; chuyển thành cài đặt, mặc định 10.

**Xong khi:** với `writeEnabled` tắt, không có lời gọi POST nào tới Meta trong test; với bật, tạm dừng một chiến dịch thử thành công và có dòng nhật ký; tăng ngân sách lần thứ hai trong 3 ngày bị từ chối.

---

### 5.6 P6: vòng học

Module mới `learn`. `requires.modules: [marketing]`. Bảng: `learn_labels` (bộ nhớ đệm nhãn theo bài), `learn_weekly` (đã viết tuần nào).

#### 5.6.1 Mỗi bài đã đăng là một ghi chú

- Nghe sự kiện bài chuyển sang `published` trong `marketing` (trạng thái ở `core/state.ts:10-12`). Tạo `noi-dung/bai/<ngay>-<slug>.md` với các khoá tĩnh.
- Mỗi lần `analytics/worker.ts` ghi một mốc mới vào `fb_post_metrics`, cập nhật `reach`, `er`, `tb_xem`, `moc_da_do` trong ghi chú. **CẦN KIỂM** `marketing` có phát sự kiện khi ghi mốc không; nếu không thì thêm `ctx.events.emit('metrics.snapshot', …)`.
- Bài từ Instagram, TikTok, YouTube đi cùng đường, nguồn là `social_video_stats` (P5).

#### 5.6.2 Gắn nhãn

Sau khi tạo ghi chú, chạy một lượt `lean`: đưa nội dung bài (bọc `untrusted`) và danh sách giá trị cho phép; đòi `{ tru_cot, mo_dau }`. Giá trị ngoài danh sách thì bỏ. Ghi vào ghi chú kèm dấu `bot gắn`; chủ sửa trong Obsidian thì giữ bản của chủ (so `data_hash`).

Mọi con số (ER trung vị theo nhãn, so sánh) do code tính từ thuộc tính các ghi chú. Agent không tính số.

#### 5.6.3 Sổ bài học

Máy trạng thái, kiểm trong `learn/server/playbook.ts`:

```
gia-thuyet ──(đủ 3 bằng chứng)──► dang-thu ──(thử xong, đạt, chủ duyệt)──► da-kiem-chung
     │                               │                                        │
     └────────(chủ bỏ)───────────────┴──(thử xong, không đạt)──► bi-bac-bo ◄──┘ (5 bài gần nhất đều dưới trung vị
                                                                                 thì quay về dang-thu, không phải bi-bac-bo)
```

- "Đạt" nghĩa là ER trung vị của các bài thử cao hơn trung vị kênh. Ngưỡng số bài thử là cài đặt, mặc định 4.
- Chỉ chủ chuyển được sang `da-kiem-chung`. Agent chỉ đề xuất, qua `ctx.attention.raise`.
- Bài học `da-kiem-chung` có `dung_boi` chứa id agent nào thì được chèn vào ngữ cảnh của agent đó qua `agentContext` của module (`src/modules/sdk.ts:183-214`). Giới hạn 10 bài học, 1.500 ký tự.

#### 5.6.4 Tổng kết tuần

`ctx.schedule.every('weekly', '30 7 * * 1', …)`. Code gom số liệu tuần trước; agent viết phần lời; ghi `tong-ket/<nam>-tuan-<so>.md`. Phần "đề xuất tuần này" là danh sách có ô đánh dấu; chủ duyệt thì mỗi dòng thành một việc qua `ctx.tasks.create`.

Lưu ý: hẹn giờ của module nằm trong bộ nhớ và không chạy bù khi máy tắt (`src/modules/context.ts:139-164`). Lúc khởi động phải kiểm `learn_weekly` và viết bù nếu tuần trước chưa có.

#### 5.6.5 Hai thước đo "có giỏi lên không"

- **ER trung vị theo tuần:** từ các ghi chú `bai-dang`.
- **Tỷ lệ nháp gửi nguyên:** từ `care_delivery_intents`. Nháp được duyệt mà `payload_revision` không đổi so với lúc tạo là "gửi nguyên". **CẦN KIỂM** nghĩa chính xác của `payload_revision` và `approved_revision` trong `persistence/outbox-store.ts:543-583`.

#### 5.6.6 Chấm trước khi đăng

`POST /api/m/learn/score-draft` nhận bản nháp, trả danh sách bài học `da-kiem-chung` kèm khớp hay không. Phần kiểm được bằng code (giờ đăng, định dạng, độ dài) thì kiểm bằng code; phần còn lại (kiểu mở đầu) dùng một lượt `lean`.

#### 5.6.7 Xong khi

- Đăng một bài, có ghi chú trong 5 giây; sau mốc 1 giờ, ghi chú có `reach`.
- Bài học thứ ba làm bằng chứng đẩy giả thuyết sang `dang-thu` và tạo một mục cần chú ý.
- Không agent nào tự chuyển được bài học sang `da-kiem-chung` (có test).
- Tắt máy qua sáng thứ Hai, mở lại thì ghi chú tổng kết vẫn được viết.

---

### 5.7 P7: Dream 100

Module mới `dream`. `requires.modules: [learn]`.

#### 5.7.1 Bảng

```sql
CREATE TABLE dream_channels (
  id TEXT PRIMARY KEY, platform TEXT NOT NULL, url TEXT NOT NULL UNIQUE, handle TEXT NOT NULL,
  why TEXT, source TEXT NOT NULL,            -- apify | rss | ytdlp | khac
  status TEXT NOT NULL DEFAULT 'active',     -- active | paused | error
  last_error TEXT, median_views INTEGER, last_scan_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE dream_videos (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, native_id TEXT NOT NULL, url TEXT NOT NULL,
  title TEXT, posted_at INTEGER, duration_s INTEGER,
  views INTEGER, likes INTEGER, comments INTEGER, shares INTEGER,
  ratio REAL,                                -- views / median_views của kênh lúc quét
  analyzed_at INTEGER, note_path TEXT, first_seen_at INTEGER NOT NULL,
  UNIQUE(channel_id, native_id)
);
CREATE TABLE dream_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, status TEXT NOT NULL,
  channels INTEGER, new_videos INTEGER, outliers INTEGER, cost_usd REAL, log TEXT, started_at INTEGER, finished_at INTEGER
);
```

Trần 100 kênh `active` kiểm trong code khi thêm.

#### 5.7.2 Dùng lại bộ thu thập của Radar

Radar đã có: mô hình `ParsedChannel` cho 7 nền tảng (`radar/server/channels.ts:6-14`), các actor Apify (`collectors/sources.ts:18-27`), RSS cho YouTube (`sources.ts:481`), và `RawItem` có `metrics` (TikTok: xem, thích, bình luận, chia sẻ, lưu; YouTube qua RSS: chỉ có lượt xem).

Bộ thu thập hiện là code nội bộ của Radar. Chuyển phần dùng chung (`collectors/apify.ts`, `rsshub.ts`, `parse.ts`, `sources.ts`) ra `modules/_lib/collect/`, để cả `radar` và `dream` cùng gọi. Radar giữ nguyên hành vi; test của Radar phải qua không sửa.

Xoay khoá Apify và tạm nghỉ 6 giờ khi khoá hết hạn mức đã có trong Radar (`radar_kv`); chuyển theo.

#### 5.7.3 Chỗ cắm nguồn dữ liệu

```ts
// modules/_lib/collect/source.ts
export interface ChannelSource {
  id: string;                                   // 'apify' | 'rss' | 'ytdlp' | ...
  supports(platform: ChannelPlatform): boolean;
  /** Video mới nhất của một kênh, kèm số đo công khai. */
  listRecent(channel: ParsedChannel, limit: number, signal: AbortSignal): Promise<RawItem[]>;
}
```

"treg" (mục 0.3), nếu là một dịch vụ lấy số liệu, sẽ là một `ChannelSource` nữa. Không cần sửa gì khác.

#### 5.7.4 Việc chạy hằng ngày

Lúc 06:00 theo giờ cấu hình, có chạy bù trong 6 giờ như Radar (`radar/server/worker.ts:24-33`):

1. **Quét.** Với mỗi kênh `active`: `listRecent(channel, 10)`. Thêm video mới vào `dream_videos`, cập nhật số đo video cũ.
2. **Tính trung vị.** `median_views` = trung vị lượt xem của tối đa 30 video gần nhất của kênh, bỏ video dưới 48 giờ tuổi. Kênh dưới 5 video thì chưa tính.
3. **Chọn nổi bật.** `ratio = views / median_views`. Lấy video có `ratio` từ ngưỡng (cài đặt, mặc định 3) và chưa `analyzed_at`. Tối đa 10 video một ngày.
4. **Mổ xẻ** từng video nổi bật (mục 5.7.5).
5. **Ghi** `dream-100/video/*.md`, cập nhật `dream-100/kenh/*.md`.
6. **Đề xuất** (mục 5.7.7).

Mỗi kênh lỗi không làm hỏng cả lượt: ghi `last_error`, đổi `status='error'` sau 3 ngày lỗi liên tiếp.

#### 5.7.5 Mổ xẻ một video

Làm bằng code, theo đúng các bước của kỹ năng `video-learn` (`modules/video/skills/video-learn/SKILL.md`), không gọi kỹ năng đó:

1. `yt-dlp --no-playlist --max-filesize 200M -f "bv*[height<=720]+ba/b[height<=720]" --write-info-json --write-auto-subs` vào `data/modules/dream/tmp/<id>/`.
2. `ffprobe` lấy độ dài. `ffmpeg -vf "select='gt(scene,0.3)',showinfo"` lấy mốc đổi cảnh. Tính số lần cắt mỗi phút, số cắt trong 3 giây đầu.
3. Trích 4 khung hình của 3 giây đầu, thu nhỏ còn rộng 540.
4. Một lượt `lean` nhận phụ đề (bọc `untrusted`), các số đo, và khung hình nếu runtime nhận ảnh. Đòi `{ mo_dau, cau_truc, keu_goi, ghi_chu }` với giá trị trong danh sách cho phép.
5. **Xoá thư mục tạm**, kể cả khi bước nào đó lỗi (`try / finally`).

Điểm phải lưu ý: runtime `genbot` khai `images: false`, nên bước 4 chạy trên GenBot sẽ không có khung hình. Hoặc cho agent phân tích chạy trên `claude`, hoặc chấp nhận chỉ phân tích bằng phụ đề.

Đường tìm `yt-dlp`, `ffmpeg` dùng lại `VIDEO_EDIT_FFMPEG`, `VIDEO_EDIT_FFPROBE` và phần kiểm của `modules/video/server/edit/doctor.ts`; chuyển phần kiểm đó ra `_lib` để không phụ thuộc module `video`. Thiếu `yt-dlp` thì module vẫn chạy bước 1 đến 3 của 5.7.4 và ghi rõ "chưa mổ xẻ được vì thiếu yt-dlp".

Luật giữ nguyên từ `video-learn`: chỉ video công khai; không lách chặn, không dùng tài khoản; chỉ lưu số đo và mô tả cấu trúc.

#### 5.7.6 Công thức

- Sau khi mổ xẻ, code tìm công thức có cùng `mo_dau` và `cau_truc` và `do_dai` trong khoảng. Có thì thêm video làm bằng chứng. Không thì đếm: từ 3 video cùng bộ nhãn trong 30 ngày thì nêu đề xuất "rút thành công thức" cho chủ.
- Chủ duyệt thì tạo `cong-thuc/<slug>.md` với `ky_vong: 1.5`, `trang_thai: chua-thu`.
- Agent không tự tạo công thức.

#### 5.7.7 Đề xuất hằng ngày

Code chọn khung, agent viết lời:

1. Code chọn 2 công thức `hop` hoặc `co-ve-hop` và 1 công thức `chua-thu`, loại chủ đề đã dùng trong 7 ngày, ưu tiên công thức vừa có video nổi bật hôm nay.
2. Với mỗi công thức, một lượt `lean` nhận công thức, video nguồn, và các ghi chú `san-pham/`, `giong-noi.md` liên quan. Đòi `{ tieu_de, cau_mo_dau, viec_can_quay }`.
3. Ghi `noi-dung/de-xuat/<ngay>.md` và nêu một mục cần chú ý.
4. Chủ bấm "Giao Bot Nội dung viết" thì tạo `fb_content` ở trạng thái `idea` kèm `meta.cong_thuc`, `meta.hoc_tu`. Khi bài được đăng, `learn` chép hai giá trị này vào ghi chú bài (mục 5.6.1). **Đây là mắt xích để so được bài với công thức; thiếu nó thì cả vòng không khép.**

#### 5.7.8 Bot Đối chiếu

Không phải một agent tự do. Là một việc trong `dream/server/compare.ts`, chạy khi một ghi chú `bai-dang` có `cong_thuc` nhận mốc 24 giờ hoặc 7 ngày:

1. `ky_vong_er` = ER trung vị các bài của mình đã làm theo công thức đó, nếu có từ 3 bài; nếu chưa thì `cong_thuc.ky_vong × ER trung vị của kênh`.
2. `so_voi_ky_vong = er / ky_vong_er`. Ghi vào ghi chú bài.
3. Tính lại `da_lam`, `ket_qua`, `trang_thai` của công thức: dưới 3 bài thì `co-ve-hop` nếu `ket_qua ≥ 1`, từ 3 bài thì `hop` nếu `ket_qua ≥ 1.2` và `chua-hop` nếu `ket_qua < 0.9`.
4. Một lượt `lean` viết hai câu giải thích chỗ khác biệt (ví dụ nhịp cắt của mình so với bản gốc), ghi vào thân ghi chú công thức.

Mọi con số ở bước 1 đến 3 do code tính.

#### 5.7.9 Chi phí

Tài liệu tích hợp Apify trong repo ghi khoảng 2 đến 6 USD cho 1.000 kết quả. Với 100 kênh và 10 kết quả mỗi kênh mỗi ngày là 1.000 kết quả, tức 2 đến 6 USD mỗi ngày. Giảm bằng cách: dùng RSS cho YouTube (miễn phí), và chỉ xin 3 video mới nhất cho kênh đã quét hôm qua. Ghi `cost_usd` mỗi lượt vào `dream_runs`, và có trần chi mỗi ngày trong cài đặt; chạm trần thì dừng và báo.

#### 5.7.10 Xong khi

- Thêm kênh thứ 101 bị từ chối.
- Một lượt chạy với bộ thu thập giả tạo đúng số ghi chú video và không để lại file trong thư mục tạm.
- Bài đăng sinh từ đề xuất có `cong_thuc` trong ghi chú; sau mốc 24 giờ có `so_voi_ky_vong`.
- Agent không tạo được file trong `cong-thuc/` (kiểm quyền ghi).
- Thiếu `yt-dlp`: module không lỗi, màn hình nói rõ thiếu gì.

---

### 5.8 P8: Gọi trợ lý

Chưa có code nào trong repo. Bản tham khảo duy nhất (`freedom_os/warroom`, Python, Pipecat, Gemini Live) không được chép. Làm một thử nghiệm kỹ thuật trước khi cam kết thiết kế.

#### 5.8.1 Thử nghiệm kỹ thuật (tối đa 3 ngày)

Trả lời ba câu, bằng đo thật:

1. Model nói realtime nào nghe và nói tiếng Việt đủ tốt, kể cả tên sản phẩm và con số tiền?
2. Độ trễ từ lúc ngừng nói tới lúc nghe trả lời là bao nhiêu trên mạng ở Việt Nam?
3. Chi phí mỗi phút gọi?

#### 5.8.2 Hình dạng dự kiến

- Trình duyệt nối thẳng tới nhà cung cấp bằng khoá tạm do lõi cấp (`POST /api/voice/session`), để khoá thật không tới trình duyệt.
- Model nói là một lớp mỏng. Nó có đúng bốn công cụ, đều do lõi thực hiện:
  - `doc_hom_nay()`: đọc danh sách cần chú ý.
  - `mo_man_hinh(ten)`: phát sự kiện để giao diện chuyển trang.
  - `doc_nhap(id)`: đọc một tin nháp hoặc bài nháp.
  - `giao_viec(bot, noi_dung)`: `ctx.tasks.create`, trả ngay; bot chạy nền.
- **Không có công cụ gửi.** Câu "gửi đi" chỉ làm nút Gửi trên màn sáng lên và đòi chủ nói lại một cụm xác nhận, hoặc bấm. Lý do: nhận dạng giọng nói có thể nghe nhầm, và một lần nhầm là một tin sai tới khách.
- Mặc định là bấm để nói. Chế độ luôn nghe là tuỳ chọn.

#### 5.8.3 Xong khi

Có báo cáo thử nghiệm với ba con số ở 5.8.1 và một khuyến nghị làm hay không làm. Chỉ sau đó mới viết module `voice`.

---

### 5.9 P9: dọn để mở nguồn

| # | Việc | Ghi chú |
|---|---|---|
| 1 | Xác nhận nguồn gốc `modules/*` | Các module được port từ FreedomOS, repo có giấy phép thương mại của "Prompt Advisers". `docs/dev/INTEGRATIONS-PLAN.md` ghi phần integration là "code của chủ, không có ở upstream", và có `scripts/check-provenance.mjs`. **Phải có người có thẩm quyền xác nhận từng module là code của chủ dự án trước khi phát hành.** Đây là rủi ro pháp lý lớn nhất của cả kế hoạch |
| 2 | Zalo | Ghi `license: "AGPL-3.0"` trong `modules/zalo/module.json`; không cài mặc định; màn thiết lập hỏi và nêu rõ |
| 3 | Gỡ phụ thuộc repo riêng | `modules/video/server/studio/bridge.ts:14` nạp `../rocketflow-extension/...` |
| 4 | Gỡ tên và đường dẫn riêng | Tên ClaudeClaw trong `src/modules/compat`, `CLAUDECLAW_CONFIG`; email trong `README.md`; đường dẫn máy cá nhân trong `docs/dev/BRIEF.md` |
| 5 | Lịch sử git | `docs/dev` nằm trong lịch sử. Cân nhắc phát hành từ một kho mới không kèm lịch sử |
| 6 | Bản gọn | Một danh sách module cài sẵn: `care`, `crm`, `marketing`, `social`, `ads`, `learn`, `dream`. `kol`, `video`, `radar`, `finance`, `gmail` là tuỳ chọn |

---

## 6. Kiểm thử chung

- Test nằm cạnh code, `*.test.ts`. Chạy một module: `npx vitest run modules/<id>`. Sau đó `npm run typecheck`.
- Module mới dùng `createTestHarness({ modulesDir })` và `fakeAgent(id, extra)` trong `src/modules/test-deps.ts:19, :86`. Ví dụ đủ ở `docs/lessons/07-viet-module-tu-template.md:442-536`.
- Không test nào gọi dịch vụ thật. GenBot, Apify, Composio, Zalo, `yt-dlp` đều có bản giả.
- Mỗi luật "bot không được làm X" phải có một test chứng minh nó bị từ chối: tự chuyển bài học sang kiểm chứng, tạo công thức, ghi vào `san-pham/`, gọi đường áp dụng quảng cáo.
- Mỗi migration phải liệt kê bảng của nó trong `module.json`, nếu không trình quản lý module từ chối (`src/modules/manager.ts:116-124`). Không có migration lùi; sửa lược đồ bằng migration mới.

---

## 7. Rủi ro và chỗ chưa chắc

| # | Rủi ro | Mức | Cách giảm |
|---|---|---|---|
| R1 | Nguồn gốc code các module (mục 5.9 việc 1) | Cao | Xác nhận trước khi làm gì khác với mục tiêu mở nguồn |
| R2 | `zca-js` là thư viện không chính thức; nick có thể bị khoá | Cao | Giữ trần và lịch làm nóng nick sẵn có; không bật marketing; nói rõ với người dùng lúc quét QR |
| R3 | GenBot giới hạn 10 lượt mỗi phút mỗi khoá | Trung bình | Bộ giới hạn ở bộ chuyển; `care` đã gom tin 3–12 giây. Shop đông khách cần GenBot nâng trần |
| R4 | Mỗi lượt một luồng mới làm đầy app GenBot | Trung bình | Bản sau thêm `sessionKey` (mục 5.1.5); hoặc xin GenBot một cờ ẩn luồng API |
| R5 | Đồng bộ hai chiều khách hàng mất dữ liệu khi xung đột | Trung bình | File thắng, mọi xung đột ghi lại và báo; test kỹ; có thể bắt đầu bằng một chiều (SQLite ra file) |
| R6 | Tên, số điện thoại khách thành chữ thường trên đĩa | Trung bình | Quyết định có chủ đích (Q4); ghi rõ trong tài liệu cho người dùng |
| R7 | Hẹn giờ module không chạy bù | Thấp | Mỗi việc định kỳ tự kiểm và chạy bù lúc khởi động |
| R8 | Tải video của kênh khác | Trung bình | Chỉ video công khai, xoá ngay sau khi đo, không lưu nội dung; trần 10 video mỗi ngày |
| R9 | Chi phí Apify với 100 kênh | Trung bình | Trần chi mỗi ngày; RSS cho YouTube |
| R10 | Ít dữ liệu nên kết luận vội (2 khách hạng A, 2 bài theo công thức) | Trung bình | Ngưỡng số mẫu tối thiểu trong code; nhãn "giả thuyết" trên giao diện |
| R11 | Agent trả JSON sai lược đồ | Thấp | Đã có ở `care` (thừa khoá là từ chối). Áp cùng cách cho `learn`, `dream`, `crm` |
| R12 | Prompt quá 20.000 ký tự ở các module khác `care` | Trung bình | Bộ chuyển trả lỗi rõ; rà từng nơi gọi `runLean` (12 nơi, danh sách ở mục 8) |

---

## 8. Câu hỏi cho người phản biện

1. Viết GenBot thành một `Runtime` (mục 5.1) có đúng là điểm nối tốt nhất không, so với nối riêng trong `care`? Có nơi nào trong 12 chỗ gọi `runLean` sẽ hỏng khi runtime không nhận ảnh và giới hạn 20.000 ký tự không? Mười hai chỗ: `modules/_template/server/index.ts:26`, `ads/server/analyst.ts:19`, `care/server/application/agent-runner-lean.ts:25`, `kol/server/agent-turn.ts:51`, `marketing/server/agent-run.ts:22`, `radar/server/agent-turn.ts:29`, `radar/server/collectors/x-grok.ts:39`, `video/server/edit/agent/director.ts:593`, `video/server/edit/assets/hub.ts:54`, `video/server/kol-port.ts:132`, `zalo/server/index.ts:127`, `src/modules/compat/agent-engine.ts:95`.
2. Đồng bộ hai chiều ở P3 có nên thay bằng một chiều cho bản đầu không? Luật "file thắng" có lỗ hổng nào?
3. Thứ tự giai đoạn có hợp lý không? Có giai đoạn nào nên cắt khỏi bản đầu?
4. Bảng mã lỗi ở 5.1.3 có ánh xạ sai `ErrorFamily` nào không, xét cách `engine.ts:248-254` và `:22, :53-63` xử lý từng họ lỗi?
5. Các mục **CẦN KIỂM** trong tài liệu: cái nào sai, cái nào đã có sẵn trong code?
6. Có chỗ nào tài liệu này mô tả code hiện có mà sai so với thực tế không?
