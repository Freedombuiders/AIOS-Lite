# P5: port thêm một module từ GỐC (chung cho các agent module)

Làm đúng như P2. Đọc theo thứ tự:
1. `docs/dev/BRIEF.md`
2. `docs/dev/prompts/p2-common.md`
3. `docs/dev/port/DECISIONS.md`
4. Module mẫu đã port: `modules/marketing`, `modules/ads`

Khác với P2:
- **Tự viết manifest** `docs/dev/port/<id>.json` (cùng định dạng các manifest có sẵn), rồi copy bằng `node scripts/port/copy.mjs`.
  - Kiểm từng file bằng `git -C ~/Developer/GitHub/claudeclaw-os cat-file -e upstream/main:<path>`: lệnh phải BÁO LỖI thì file mới là của chủ và được copy.
  - Gồm cả test và giao diện (trang, component, lib, style) mà module cần.
- **Tách SQL** bằng `node scripts/port/extract-db-sections.mjs`, hoặc lấy từ `git -C ~/Developer/GitHub/claudeclaw-os diff upstream/main -- src/db.ts` (chỉ lấy dòng thêm). Đặt vào `modules/<id>/migrations/001_init.sql`.
  - Giữ nguyên tên bảng của GỐC.
  - Khai báo đủ `tables` trong `module.json`.
- **Integration riêng của module** (fal, Higgsfield, Apify, RSSHub, HeyGen…) khai trong `defineModule({ integrations: [...] })`, kiểu ở `src/integrations/types.ts`. Chúng tự hiện ở **Kết nối → Integrations** khi module được bật.
  - Đọc key bằng `ctx` (lệnh integration nhận `values`).
  - Hoặc đọc bằng `src/integrations/store.ts` qua service: dùng `integrationServiceFor` trong `src/integrations/mount.ts`. Nếu cần hàm đọc key từ module, ghi vào báo cáo.
- **`js-yaml` không có:** dùng gói `yaml`.
- **Gói đã cài:** `adm-zip`, `@openai/codex-sdk`, `@google/genai`, `@modelcontextprotocol/sdk`, `image-size`, `cron-parser`, `croner`.
- **Lượt agent** dùng `ctx.agents.runLean`. Thao tác agent cần ghi vào module thì làm thành `actions` (`<aios-action>`). Dữ liệu ngắn cho agent đưa vào `agentContext`.
- **Không gọi dịch vụ thật** trong test (fal, Higgsfield, Apify, Grok, Gemini, HeyGen, Meta…).
- **Nhóm menu** (`category` trong `module.json`, `group` trong `web/index.tsx`): `studio` (AI Studio), `marketing`, `finance`, `sales`, `ops`, `other`.

**Xong khi:**
- `npx vitest run modules/<id>` xanh.
- `npx tsc -p tsconfig.json --noEmit` và `npx tsc -p web/tsconfig.json --noEmit` không có lỗi nào trong `modules/<id>`.
- `node scripts/check-provenance.mjs` báo 0 trùng.
- Có test Add/Remove qua module manager.
- Có `README.md` (tiếng Việt) và `PORTING.md`.

Báo cáo theo mẫu ở BRIEF.
