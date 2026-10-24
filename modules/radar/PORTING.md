# Port Radar thị trường từ GỐC

Nguồn: `src/radar/**`, `web/src/pages/radar/**`, `web/src/lib/radar.ts` của GỐC (cây làm việc, gồm phần chưa commit: Kênh theo dõi, RSSHub). Tất cả là file của chủ (không có trong `upstream/main`). Manifest: `docs/dev/port/radar.json`.

## Đã sửa

| Phần | Thay đổi | Lý do |
|---|---|---|
| `db` (`getApplicationDb`, `getDashboardSetting`) | `context.ts` (ngữ cảnh module) + `kv.ts` (bảng `radar_kv`) | Module chỉ dùng `ctx.db`; không có bảng settings chung |
| `logger` | `log.ts` chuyển tới `ctx.log` | Không import lõi |
| `schema.ts` | Chuyển thành `migrations/001_init.sql` | Quy ước module; thêm bảng `radar_kv` |
| `agent-turn.ts` | Viết lại bằng `ctx.agents.runLean` | Engine quản mọi lượt agent |
| `x-grok.ts` | Không gọi `grok` CLI nữa; đọc X qua một lượt lean của agent `radar-analyst` (runtime Grok), giữ chữ ký `execGrok` để test; bỏ `resolveGrokBin`, `grokLoggedIn` | Quyết định: LLM đi qua `runLean`. CLI không phải HTTP API |
| `toolStatus` | Mục `grok` báo trạng thái agent `radar-analyst` | Cùng lý do |
| `loadIntegrationValues` | `integration-values.ts` đọc qua `integrationServiceFor(deps).credentials.loadValues` | Apify/RSSHub là integration của module |
| `apify-integration.ts`, `rsshub-integration.ts` | Khai trong `defineModule({ integrations })` | Hiện ở Kết nối khi module bật |
| `worker.ts` | `ctx.schedule.every('tick', 60s)`; công tắc chính là cài đặt module `enabled` (mặc định tắt); thông báo qua `ctx.attention.raise` | Quy ước lịch của module |
| `config.ts` | `enabled` lấy từ cài đặt module, không từ JSON | Một công tắc duy nhất |
| `routes.ts` | Bỏ tiền tố `/api/radar`, mount ở `/api/m/radar`; thêm `GET /latest` | Quy ước đường dẫn |
| `time.ts` | Dùng `tz.ts` (bản của `fbstudio/analytics/time`, đã có trong marketing) | Không import chéo module |
| Web | `/marketing/radar` → `/m/radar`; `components/ui.tsx` thay `fb/ops-shared` và `fb/common` (chỉ phần Radar dùng); link `/integrations` → `/connections`; mục Grok CLI thành "Agent đọc X" | Quy ước web module |
| `RADAR_RSSHUB_URL` (biến môi trường) | Bỏ | Không đọc `process.env` ngoài config; dùng trường `base_url` của integration |
| Mặc định `analysisAgentId` | `main` → `radar-analyst` | Agent mẫu của module |
| Thư mục lưu trình duyệt | `~/.claudeclaw/radar` → `ctx.dataDir/radar` | Dữ liệu module nằm trong `data/modules/radar` |

## File thêm mới (không từ GỐC)

`server/context.ts`, `kv.ts`, `log.ts`, `integration-values.ts`, `summary.ts`, `index.ts`, `test-db.ts`, `module.test.ts`, `lifecycle.test.ts`, `server/tz.ts` (từ marketing), `web/index.tsx`, `web/components/ui.tsx`, agent `radar-analyst`, skill `radar-review`.

## Bỏ

- `src/radar/schema.ts`, `src/radar/index.ts`, `src/radar/agent-turn.ts` (xem trên).
- `e2e/radar.spec.ts`: Playwright của GỐC, không port.

## Chưa làm được / lưu ý

- Quét thật chưa kiểm (cần Apify token, RSSHub, agent Grok đăng nhập). Test chỉ dùng bản giả.
- Chrome riêng cho nhóm Facebook kín (playwright) vẫn là tính năng thử nghiệm, cần cài playwright riêng.
