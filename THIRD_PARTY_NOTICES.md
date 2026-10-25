# Thông báo về mã và thư viện của bên thứ ba

AIOS-Lite có dùng mã của một số dự án khác và nhiều thư viện mã nguồn mở. File này ghi rõ phần nào đến từ đâu và theo giấy phép nào, để bạn tuân thủ khi dùng hoặc phân phối lại.

Giấy phép của chính AIOS-Lite là **MIT**, © 2026 Tony Hoang (file [LICENSE](LICENSE)); repo hiện ở GitHub riêng tư `hoanghd218/AIOS-Lite`, dự kiến mở mã nguồn sau. Riêng thư mục `modules/zalo/` theo **AGPL-3.0** (xem mục 3).

## Mục lục

1. [Paperclip (MIT)](#1-paperclip-mit)
2. [Mã do chủ dự án tự viết ở bản FreedomOS riêng](#2-mã-do-chủ-dự-án-tự-viết-ở-bản-freedomos-riêng)
3. [ZaloCRM (AGPL-3.0): module `zalo`](#3-zalocrm-agpl-30-module-zalo)
4. [Thư viện npm chính](#4-thư-viện-npm-chính)
5. [Công cụ dòng lệnh bên ngoài](#5-công-cụ-dòng-lệnh-bên-ngoài)
6. [OpenFilm (MIT): module `video`, Dựng nhanh](#6-openfilm-mit-module-video-dựng-nhanh)
7. [FireRed-OpenStoryline (Apache-2.0): module `video`, kho tư liệu Dựng nhanh](#7-firered-openstoryline-apache-20-module-video-kho-tư-liệu-dựng-nhanh)
8. [open-edit (Apache-2.0): module `video`, đo tiếng nói](#8-open-edit-apache-20-module-video-đo-tiếng-nói)
9. [video-use (MIT): module `video`, HDR sang SDR và phụ đề Dựng nhanh](#9-video-use-mit-module-video-hdr-sang-sdr-và-phụ-đề-dựng-nhanh)

Phụ lục: [toàn văn Apache License 2.0](#phụ-lục-toàn-văn-apache-license-20) (mục 7 và 8).

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

## 6. OpenFilm (MIT): module `video`, Dựng nhanh

Lớp chỉnh tay (overrides) và thao tác plan theo id của tab Dựng nhanh được viết lại bằng TypeScript dựa trên [OpenFilm](https://github.com/openfilm/openfilm) (giấy phép MIT, bản đọc ở commit `42c46e6`). Mỗi file bên dưới có ghi chú nguồn ở đầu file.

| File nguồn của OpenFilm (`packages/openfilm/`) | File trong AIOS-Lite | Mức độ lấy |
|---|---|---|
| `studio/ui/src/lib/film-overrides.ts` (`tidy`, `mergeStyle`, `nextOverrides`) | `modules/video/server/edit/overrides.ts` (`mergeElementOverride`, `mergeOverrides`) | Viết lại theo cùng luật: khoá không nêu thì giữ, `null` xoá, khoá lồng nhau gộp từng khoá, mục không còn gì thì bỏ |
| `studio/ui/src/lib/dropped-overrides.ts` (`droppedOverrides`) | `modules/video/server/edit/overrides.ts` (`droppedElements`) | Viết lại cho plan theo phiên bản: phần tử có chỉnh tay mà bản AI mới làm mất |
| `studio/server/ops.mjs` (`applyOps`, `EditError`, `mintClipId`) | `modules/video/server/edit/plan-ops.ts` (`applyPlanOps`, `PlanOpError`) | Viết lại cho EditPlan: thao tác theo id, lỗi `conflict`/`invalid`, nửa phải khi tách có id `<id>-b` |
| `studio/ui/src/editor/undo.ts` (`inverse`) | `modules/video/server/edit/plan-ops.ts` (op `restore`) | Chỉ lấy ý tưởng: khôi phục theo id, phần tử đã có lại thì không làm gì |
| `src/overrides.mjs` (`override`) | `modules/video/server/edit/pipeline/composition-v2/overrides.ts` (`overridesScript`) | Lấy cách áp sau mỗi lần vẽ khung bằng thuộc tính CSS `translate`/`scale` riêng; viết lại cho phần tử theo `data-el-id` (chữ, props, hiệu ứng vào, thời gian, ẩn áp lúc dựng composition) |

Thông báo bản quyền của OpenFilm:

```
MIT License

Copyright (c) 2026 OpenFilm contributors

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

## 7. FireRed-OpenStoryline (Apache-2.0): module `video`, kho tư liệu Dựng nhanh

Phần đo nhịp nhạc và các prompt mô tả tư liệu, gắn nhãn nhạc của kho tư liệu (Asset Hub) trong tab Dựng nhanh được viết lại bằng TypeScript dựa trên [FireRed-OpenStoryline](https://github.com/FireRedTeam/FireRed-OpenStoryline) (giấy phép Apache 2.0, bản đọc ở commit `c9e9452`). `beats.ts` và `prompts.ts` có ghi chú nguồn, bản quyền và các thay đổi ở đầu file; `indexer.ts` chỉ lấy cách chọn số khung, ghi nguồn ngay trên hàm `frameTimes`.

| File nguồn của OpenStoryline | File trong AIOS-Lite | Mức độ lấy |
|---|---|---|
| `src/open_storyline/nodes/core_nodes/select_bgm.py` (`analyze_music_metrics`, `_compute_accent_beats`) | `modules/video/server/edit/assets/beats.ts` | Viết lại bằng TypeScript: cùng các bước đo BPM, nhịp và chọn nhịp mạnh (top 70 %, chuẩn hoá cục bộ 8 nhịp, giữ đỉnh cục bộ, cách nhau ít nhất 1 nhịp), năng lượng trung bình và độ chênh. Thay librosa bằng phổ tự tính, không tách phần bộ gõ trước khi chọn nhịp mạnh, thời điểm tính bằng giây |
| `prompts/tasks/understand_clips/{en,zh}/system_detail.md`, `src/open_storyline/nodes/core_nodes/understand_clips.py`, `src/open_storyline/mcp/sampling_handler.py` (số khung 2–6, 3 khung/giây, cạnh dài 600 px) | `modules/video/server/edit/assets/prompts.ts` (`clipIndexPrompt`), `modules/video/server/edit/assets/indexer.ts` (`frameTimes`), `modules/video/server/edit/assets/hub.ts` (`frames`, cạnh dài 600 px) | Dịch và chỉnh prompt sang tiếng Việt, đổi `aes_score` thành `quality`; giữ cách chọn số khung và cỡ khung |
| `prompts/tasks/scripts/{en,zh}/omni_bgm_label.md`, `scripts/omni_bgm_label.py` | `modules/video/server/edit/assets/prompts.ts` (`musicLabelPrompt`) | Chỉnh prompt: agent không nghe được âm thanh nên đọc số đo, tên, mô tả và ảnh phổ; mood theo 6 mood của module |

OpenMontage (AGPL-3.0) chỉ được học ý tưởng cho cách tìm và chấm cảnh trám (mô tả đầy đủ để chấm, từ khoá ngắn để tìm, chấm 1–5, tránh hai cảnh giống nhau liền nhau); không có mã nào của OpenMontage trong AIOS-Lite (`assets/resolve.ts`, `assets/prompts.ts` ghi rõ điều này).

Prompt cắt thô từng câu của đạo diễn (`modules/video/server/edit/agent/director.ts`, `ROUGH_CUT_RULES`) chỉ học ý tưởng từ OpenStoryline (`prompts/tasks/speech_rough_cut`) và luật chọn lần nói tốt nhất của video-use (mục 9); viết lại bằng tiếng Việt, không chép chữ hay mã.

Thông báo bản quyền của FireRed-OpenStoryline:

```
Copyright 2026 FireRed-OpenStoryline Authors. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

Toàn văn giấy phép Apache 2.0: [phụ lục](#phụ-lục-toàn-văn-apache-license-20) cuối file. OpenStoryline không có file NOTICE.

## 8. open-edit (Apache-2.0): module `video`, đo tiếng nói

Bước chép lời của Dựng nhanh đo tiếng nói từ âm thanh thật, dựa trên [open-edit](https://github.com/veedstudio/open-edit) của VEED (giấy phép Apache License 2.0, bản đọc ở commit `1d3b75b`). Mỗi file bên dưới có ghi chú nguồn và bản quyền ở đầu file.

| File nguồn của open-edit | File trong AIOS-Lite | Mức độ lấy |
|---|---|---|
| `cli/src/commands/speech-probe.ts` (`envelopeOf`, `percentile`, `analyse`, `MIN_DYNAMIC_RANGE_DB`) | `modules/video/server/edit/pipeline/speech-probe.ts` | Chép gần nguyên logic đo mức âm theo cửa sổ, nền nhiễu đo theo từng clip và khoảng lặng an toàn để cắt; bỏ phần CLI, đọc PCM từ file WAV 16 kHz. Phần tìm tiếng không thành lời (`voicedRuns`, `unwordedSounds`, `insertSyntheticWords`) do AIOS-Lite viết thêm |
| `cli/src/transcript/whisper-mapper.ts` (`tokenize`, `timeAll`, `orderWords`) | `modules/video/server/edit/pipeline/transcribe.ts` (`parseWhisperJson`) | Viết lại cho JSON của whisper.cpp: tách token nhiều từ theo độ dài, gán thời gian cho token thiếu mốc từ hai bên, sắp lại từ có mốc chạy ngược |

Giấy phép Apache 2.0 yêu cầu giữ thông báo bản quyền, ghi rõ file đã sửa và kèm nội dung NOTICE liên quan. Toàn văn giấy phép: [phụ lục](#phụ-lục-toàn-văn-apache-license-20) cuối file. NOTICE của open-edit (phần liên quan; phần còn lại nói về font của trang đăng nhập và dịch vụ VEED, AIOS-Lite không dùng):

```
open-edit
Copyright 2026 VEED LIMITED

This product includes software developed at VEED (https://www.veed.io/).

Licensed under the Apache License, Version 2.0 (see the LICENSE file).
```

## 9. video-use (MIT): module `video`, HDR sang SDR và phụ đề Dựng nhanh

Bước chuẩn hoá video chuyển video HDR (HLG của iPhone, PQ) sang SDR bằng chuỗi bộ lọc lấy từ [video-use](https://github.com/browser-use/video-use) (giấy phép MIT, bản đọc ở commit `43cfc56`), và composition Dựng nhanh chia phụ đề thành cụm ngắn theo cùng luật của video-use. Mỗi file có ghi chú nguồn và bản quyền: `captions.ts` ở đầu file, `normalize.ts` ngay trên `HDR_TRANSFERS`.

| File nguồn của video-use | File trong AIOS-Lite | Mức độ lấy |
|---|---|---|
| `helpers/render.py` (`HDR_TRANSFERS`, `TONEMAP_CHAIN`, `is_hdr_source`) | `modules/video/server/edit/pipeline/normalize.ts` (`HDR_TRANSFERS`, `TONEMAP_CHAIN`, `probeColorTransfer`, `masterVideoFilter`) | Chép chuỗi `zscale` + `tonemap` (Hable) và cách nhận ra nguồn HDR; viết lại bằng TypeScript, chỉ bật khi ffmpeg có zimg |
| `helpers/render.py` (`chunk_words`, `CHUNK_WORDS`, `CHUNK_MAX_WORDS`, `CHUNK_MIN_S`, `CHUNK_PAUSE_S`, `PUNCT_BREAK`) | `modules/video/server/edit/pipeline/composition-v2/captions.ts` (`chunkWords`) | Viết lại cùng luật: ngắt ở dấu câu hoặc khoảng lặng ≥0,3s, mặc định 2 từ, cụm ngắn hơn 0,35s được thêm từ tới mức tối đa (lấy `maxWordsPerChunk` của mẫu thay cho 3) |

Thông báo bản quyền của video-use:

```
MIT License

Copyright (c) 2026 Browser Use

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

---

Nếu bạn thấy một nguồn gốc còn thiếu hoặc ghi sai, hãy sửa file này cùng lúc với việc thêm mã. Mỗi lần chép mã từ một dự án ở trên, hãy thêm dòng vào bảng của mục tương ứng (Paperclip: mục 1) và giữ ghi chú nguồn ở file chép.

## Phụ lục: toàn văn Apache License 2.0

Điều khoản dưới đây áp dụng cho phần mã lấy từ FireRed-OpenStoryline (mục 7) và open-edit (mục 8), chép nguyên từ file `LICENSE` của hai dự án (hai file giống nhau tới hết phần điều khoản).

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
```
