# P2 — chung cho mọi agent module

Bạn là agent port một module của AIOS-Lite (repo `~/Developer/GitHub/AIOS-Lite`).

Đọc theo thứ tự:
1. `docs/dev/BRIEF.md` (quy tắc cứng, license, cách báo cáo)
2. `docs/ARCHITECTURE.md` §9 (hệ thống module)
3. `docs/MODULES.md` (phần module của bạn)
4. `docs/dev/port/DECISIONS.md` (13 quyết định, bắt buộc theo)
5. `docs/dev/port/<module>.md` và `<module>.json` (manifest)
6. `src/modules/sdk.ts` (SDK, thứ duy nhất module được dùng), `src/modules/compat/` (thay thế các import upstream)
7. `modules/_template/` (khuôn module mẫu đã chạy), `modules/_lib/composio.ts` (Composio dùng chung), `modules/_lib/care-kit/` (hợp đồng kênh của care: chỉ import, không sửa)

Quy trình:
1. `node scripts/port/copy.mjs docs/dev/port/<module>.json`. Nếu cần sửa manifest thì sửa JSON trước khi copy.
2. Tách SQL: `node scripts/port/extract-db-sections.mjs --prefix <prefix> --out <tmp>`. Bổ sung các hàm owner nằm ngoài marker (xem DECISIONS §11). Kết quả đặt vào `modules/<id>/migrations/001_init.sql` và `modules/<id>/server/store*.ts`.
3. Xoá phần bỏ, nối lại import (SDK / compat / `_lib`), viết `module.json` (khai báo `tables`, `scopes`, `settings`, `requires`), `server/index.ts` (`defineModule`) và `web/index.tsx` (`defineWebModule`).
4. Thêm agent mẫu và skill trong `modules/<id>/agents/` và `modules/<id>/skills/`.
5. Sửa test đã copy cho xanh: `npx vitest run modules/<id>`. Kiểm tra thêm `npx tsc -p tsconfig.json --noEmit`, `npx tsc -p web/tsconfig.json --noEmit` (lỗi trong module của bạn phải bằng 0) và `node scripts/check-provenance.mjs` (0 hit).
6. Ghi `modules/<id>/README.md` (tiếng Việt) và cập nhật `PORTING.md` (những gì đã xoá hoặc sửa, kèm lý do).

Ranh giới:
- Chỉ ghi trong `modules/<id>/**`.
- Ngoại lệ: `modules/_lib/fb-types.ts` (chỉ marketing và ads, theo DECISIONS §6) và `docs/dev/notices-pending.md` (chỉ thêm dòng).
- Không sửa `src/**`, `web/src/**` hay module khác. Cần lõi bổ sung gì thì ghi vào báo cáo.
- Không gọi dịch vụ thật (Facebook, Zalo, Gmail, Composio, Meta).

Sở hữu file trong P2 (các agent chạy song song):

| Agent | Được ghi |
|---|---|
| care (Claude Sonnet) | `modules/care/**` |
| zalo (Claude Sonnet) | `modules/zalo/**` |
| marketing (Claude Sonnet) | `modules/marketing/**`, `modules/_lib/fb-types.ts` |
| gmail (Codex) | `modules/gmail/**` |
| ads (Codex) | `modules/ads/**`, `modules/_lib/fb-types.ts` (chỉ thêm, phối hợp với marketing) |

- `modules/_lib/composio.ts` và `modules/_lib/care-kit/**` là của coordinator. Cần thay đổi thì ghi vào báo cáo.
- Module của bạn phải chạy được khi module khác chưa Add: dùng `ctx.modules.get()` và kiểm tra `undefined`.
- Test của bạn dùng fake cho module khác, không import code của module khác.
