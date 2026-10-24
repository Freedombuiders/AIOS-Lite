# scripts/

Công cụ port từ repo GỐC (fork claudeclaw-os) sang AIOS-Lite. Không thêm npm dependency.

## port/copy.mjs
`node scripts/port/copy.mjs <manifest.json> [--dry-run] [--force] [--source <path>]` (mặc định nguồn: env `AIOS_PORT_SOURCE` hoặc `/Users/tonyhoang/Developer/GitHub/claudeclaw-os`).
Manifest: `{ "module": "care", "entries": [{ "from", "to", "kind": "A|B|D", "note" }], "drop": [{ "from", "reason" }] }`.
Từ chối (exit 1, không ghi gì) nếu bất kỳ file nào tồn tại ở `upstream/main`; bỏ qua file thuộc `drop`; không ghi đè trừ khi `--force`; ghi log vào `modules/<module>/PORTING.md`.

## port/extract-db-sections.mjs
`node scripts/port/extract-db-sections.mjs --list` hoặc `--prefix zalo [--prefix email] --out <dir> [--exclude-flagged]`.
Trích các section có marker (`-- @x-schema:name`, `// @x-db:name`, `// @x-migrations:name`) từ `src/db.ts`. Quy tắc: section bắt đầu tại dòng marker, kết thúc trước marker kế tiếp (bất kỳ loại), hoặc (schema) dòng đóng template backtick, hoặc (migrations) dòng trống đầu tiên sau nội dung, hoặc EOF. Dòng >= 12 ký tự trùng upstream db.ts bị báo (exit 2).
Xuất `schema.sql`, `store.extracted.ts`, `migrations.extracted.ts`, `tables.json`.

## check-provenance.mjs
Xem `scripts/provenance/README.md`. `--build-index` rồi chạy không tham số để kiểm tra.

## Test
`node --test "scripts/**/*.test.mjs"`.
