# Thông báo về mã và thư viện của bên thứ ba

AIOS-Lite có dùng mã của một số dự án khác và nhiều thư viện mã nguồn mở. File này ghi rõ phần nào đến từ đâu và theo giấy phép nào, để bạn tuân thủ khi dùng hoặc phân phối lại.

Giấy phép của chính AIOS-Lite là **MIT**, © 2026 Tony Hoang (file [LICENSE](LICENSE)); repo hiện ở GitHub riêng tư `hoanghd218/AIOS-Lite`, dự kiến mở mã nguồn sau. Riêng thư mục `modules/zalo/` theo **AGPL-3.0** (xem mục 3).

## Mục lục

1. [Paperclip (MIT)](#1-paperclip-mit)
2. [Mã do chủ dự án tự viết ở bản FreedomOS riêng](#2-mã-do-chủ-dự-án-tự-viết-ở-bản-freedomos-riêng)
3. [ZaloCRM (AGPL-3.0): module `zalo`](#3-zalocrm-agpl-30-module-zalo)
4. [Thư viện npm chính](#4-thư-viện-npm-chính)
5. [Công cụ dòng lệnh bên ngoài](#5-công-cụ-dòng-lệnh-bên-ngoài)

---

## 1. Paperclip (MIT)

Một phần của lớp runtime (`src/runtimes/`) được viết lại dựa trên [Paperclip](https://github.com/paperclipai/paperclip), một dự án mã nguồn mở giấy phép MIT.

| File nguồn của Paperclip | File trong AIOS-Lite | Mức độ lấy |
|---|---|---|
| `packages/adapters/grok-local/src/shared/turn-boundary.ts` | `src/runtimes/grok.ts` (hàm `applyTurnBoundary`) | Viết lại, giữ gần nguyên logic |
| `packages/adapter-utils/src/server-utils.ts` (`runChildProcess`) | `src/runtimes/process.ts` | Chỉ lấy ý tưởng, không chép mã |
| `packages/adapters/{claude,codex,grok}-local/src/server/parse.ts` | `src/runtimes/{claude,codex,grok}.ts` | Chỉ lấy ý tưởng: cách đọc sự kiện, cách nhận ra lỗi khi nối phiên |
| `packages/adapter-utils/src/command-redaction.ts` | `src/runtimes/jsonl.ts` (`describeCommand`) | Chỉ lấy ý tưởng, không chép mã |

Giấy phép MIT của Paperclip yêu cầu giữ nguyên thông báo bản quyền và nội dung giấy phép khi chép hoặc dùng phần đáng kể của mã. Thông báo đó như sau:

```
MIT License

Copyright (c) 2025 Paperclip AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Ngoài các file trên, thiết kế tổng thể của AIOS-Lite (giao việc nguyên tử, quy tắc "không việc nào bị bỏ quên", nhóm lỗi của runtime, trạng thái `review`) học từ cách Paperclip tổ chức công việc. Đó là ý tưởng, không phải mã chép.

## 2. Mã do chủ dự án tự viết ở bản FreedomOS riêng

Một số file được sao chép từ bản FreedomOS riêng (private) của chủ dự án, rồi chỉnh để chạy trên Module SDK của AIOS-Lite. **Đây là mã do chính chủ dự án viết**, không phải mã của bên thứ ba, và được đưa vào AIOS-Lite với quyền của tác giả. Ghi ở đây để rõ nguồn gốc.

| File trong AIOS-Lite | Nguồn trong bản FreedomOS | Chỉnh sửa |
|---|---|---|
| `modules/_lib/composio.ts` | `src/fbstudio/composio.ts` | Import đổi sang `configureComposio` |
| `modules/_lib/care-kit/{types,errors,checkpoint,validation,contract}.ts` | `src/customer-care/{domain/*,connectors/contract}.ts` | Dùng nguyên, thêm `index.ts` |
| Phần lớn mã trong `modules/care/`, `modules/gmail/`, `modules/marketing/`, `modules/ads/` và phần không thuộc ZaloCRM của `modules/zalo/` | Các thư mục nghiệp vụ tương ứng của FreedomOS | Viết lại trên Module SDK, bỏ phần thừa; chi tiết từng module nằm ở `PORTING.md` trong thư mục module |

Mã gốc từ dự án ClaudeClaw (upstream) **không** được đưa vào AIOS-Lite. Lệnh `npm run provenance` quét toàn bộ repo để chắc chắn không có đoạn dài nào trùng với mã upstream đó.

## 3. ZaloCRM (AGPL-3.0): module `zalo`

12 file trong `modules/zalo/server/` có nguồn gốc từ **ZaloCRM** (`full_crm/ZaloCRM`), giấy phép **GNU Affero General Public License phiên bản 3** (AGPL-3.0). Các file đó được chỉnh để chạy trong AIOS-Lite (đổi import, đổi cách đọc cài đặt, bỏ đường trả lời bằng AI cũ) nhưng cấu trúc, các giới hạn chống khoá nick và hành vi vẫn đến từ ZaloCRM:

```
modules/zalo/server/birthday-schedule.ts   modules/zalo/server/rich-text.ts
modules/zalo/server/birthday.ts            modules/zalo/server/schedule.ts
modules/zalo/server/content.ts             modules/zalo/server/sender.ts
modules/zalo/server/group-broadcast.ts     modules/zalo/server/session.ts
modules/zalo/server/history.ts             modules/zalo/server/template.ts
modules/zalo/server/ingest.ts              modules/zalo/server/limits.ts
```

Vì vậy **toàn bộ thư mục `modules/zalo/` được phân phối theo AGPL-3.0**:

- Toàn văn giấy phép: [`modules/zalo/LICENSE`](modules/zalo/LICENSE).
- Danh sách file và thông báo: [`modules/zalo/NOTICE`](modules/zalo/NOTICE) (đây là nguồn chính xác nhất; nếu danh sách trên đây lệch với NOTICE thì NOTICE đúng).
- Nếu bạn chạy một bản đã sửa của module này như một dịch vụ mạng, mục 13 của AGPL yêu cầu bạn cung cấp mã nguồn tương ứng cho người dùng dịch vụ đó. Ai phát hành bản có kèm module `zalo` cũng phải kèm mã nguồn của module này.
- Các phần còn lại của AIOS-Lite chỉ giao tiếp với module `zalo` qua Module SDK (`src/modules/sdk.ts`) và `provides`, nên giữ giấy phép riêng của chúng.
- Muốn phát hành AIOS-Lite mà không phải kèm mã nguồn của `zalo`, hãy loại thư mục `modules/zalo/` khỏi bản phát hành. Các module khác không phụ thuộc vào nó.

Thư viện `zca-js` mà module `zalo` dùng là MIT (xem mục 4).

## 4. Thư viện npm chính

Bảng dưới liệt kê các thư viện được khai báo trong `package.json`, kèm phiên bản đang cài và giấy phép đọc từ `node_modules/<tên>/package.json`. Mỗi thư viện còn kéo theo các thư viện phụ thuộc khác có giấy phép riêng; muốn danh sách đầy đủ, chạy `npm ls --all` rồi xem file giấy phép trong từng thư mục ở `node_modules`.

### Chạy trên máy chủ

| Thư viện | Phiên bản | Giấy phép | Dùng để |
|---|---|---|---|
| [hono](https://github.com/honojs/hono) | 4.13.13 | MIT | Khung web cho API |
| [@hono/node-server](https://github.com/honojs/node-server) | 1.19.17 | MIT | Chạy Hono trên Node |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | 12.11.1 | MIT | Cơ sở dữ liệu SQLite |
| [zod](https://github.com/colinhacks/zod) | 4.4.3 | MIT | Kiểm tra dữ liệu (agent.yaml, module.json) |
| [yaml](https://github.com/eemeli/yaml) | 2.9.1 | ISC | Đọc và ghi file YAML |
| [croner](https://github.com/hexagon/croner) | 10.0.1 | MIT | Hẹn giờ theo cron cho module |
| [cron-parser](https://github.com/harrisiirak/cron-parser) | 5.10.2 | MIT | Tính lần chạy kế tiếp của lịch |
| [pino](https://github.com/pinojs/pino) | 9.14.0 | MIT | Ghi nhật ký |
| [zca-js](https://github.com/RFS-ADRENO/zca-js) | 2.1.2 | MIT | Kết nối Zalo (module `zalo`) |
| [@composio/core](https://github.com/ComposioHQ/composio) | 0.22.0 | ISC | Gọi Facebook, Meta Ads, Gmail qua Composio |
| [image-size](https://github.com/image-size/image-size) | 2.0.2 | MIT | Đọc kích thước ảnh |
| [@google/genai](https://github.com/googleapis/js-genai) | 1.52.0 | Apache-2.0 | Gọi Gemini (module `kol`) |
| [@openai/codex-sdk](https://github.com/openai/codex) | 0.159.2 | Apache-2.0 | Chạy Codex trong module `kol` |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | 1.32.2 | MIT | Máy chủ MCP của module `finance` và `video` |
| [adm-zip](https://github.com/cthackers/adm-zip) | 0.6.1 | MIT | Đọc và đóng gói file .zip (gói team, thư viện mẫu của `video`) |

### Giao diện web

| Thư viện | Phiên bản | Giấy phép | Dùng để |
|---|---|---|---|
| [preact](https://github.com/preactjs/preact) | 10.29.8 | MIT | Khung giao diện |
| [@preact/signals](https://github.com/preactjs/signals) | 2.11.3 | MIT | Trạng thái phản ứng |
| [wouter-preact](https://github.com/molefrog/wouter) | 3.13.0 | Unlicense (phạm vi công cộng) | Định tuyến trang |
| [lucide-preact](https://github.com/lucide-icons/lucide) | 1.61.0 | ISC | Biểu tượng |
| [marked](https://github.com/markedjs/marked) | 18.1.1 | MIT | Hiển thị Markdown |
| [dompurify](https://github.com/cure53/DOMPurify) | 3.4.17 | MPL-2.0 hoặc Apache-2.0 (chọn một) | Làm sạch HTML trước khi hiển thị |
| [tailwindcss](https://github.com/tailwindlabs/tailwindcss) | 4.3.3 | MIT | CSS (chỉ dùng lúc build) |
| [@hyperframes/player](https://www.npmjs.com/package/@hyperframes/player) | 0.8.156 | Apache-2.0 | Trình xem trước video trong module `video` |

Ghi chú:

- `dompurify` được cấp theo hai giấy phép song song. AIOS-Lite dùng nó nguyên bản, không sửa mã.
- Công cụ phát triển (TypeScript, Vite, Vitest, tsx, jsdom, concurrently và các `@types/*`) không đi vào sản phẩm khi chạy; giấy phép của chúng nằm trong `node_modules`.

## 5. Công cụ dòng lệnh bên ngoài

AIOS-Lite **không** kèm theo và không phân phối các CLI sau. Bạn tự cài và tự đăng nhập, theo điều khoản của từng nhà cung cấp: Claude Code (Anthropic), Codex (OpenAI), Grok Build (xAI), Hermes / Rocket Agent. AIOS-Lite chỉ gọi chúng như các tiến trình con.

---

Nếu bạn thấy một nguồn gốc còn thiếu hoặc ghi sai, hãy sửa file này cùng lúc với việc thêm mã. Mỗi lần chép mã từ Paperclip, hãy thêm dòng vào bảng ở mục 1.
