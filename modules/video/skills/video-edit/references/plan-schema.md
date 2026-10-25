# EditPlan: bạn quyết định gì, máy làm gì

Bạn trả JSON trong một khối ```json ở câu trả lời cuối; máy kiểm tra và nộp. Máy tính phần dẫn xuất: `keep` (các đoạn giữ, từ `cutWords` + `gapMs`), `removed`, `outputDurationSec`, `version`, `createdAt`, `author`. **Bạn không điền những trường đó.**

## Hai hệ thời gian

- `keep`, `removed`, `covers[].frameAt`: **giây trong video gốc** (source).
- `overlays[].at`, `zooms[].at`, `sfx[].at`: **giây trong video đã dựng** (output).
- `beats[].at`, `scenes[].at`, `graphics[].at` (plan v2): cũng là **giây trong video đã dựng**.
- `anchorWord` (chỉ số từ trong lời chép, trường `i`): máy dùng để **dời lại** hiệu ứng/B-roll khi danh sách cắt đổi. Có thể có cả `anchorWord` lẫn `at`; luôn ưu tiên đặt `anchorWord`, và đặt `at` là ước tính hiện tại. **Không neo vào từ nằm trong `cutWords`**, `plan validate` sẽ báo lỗi.
- Từ ghi `(tiếng)` trong lời chép là tiếng không thành lời (máy đoán là từ đệm): cắt được như từ đệm, không bao giờ đưa vào chữ, phụ đề hay tiêu đề.

## Các trường

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `styleId` | string | id phong cách (`styles list`), ví dụ `kienthuc` |
| `aspect` | `9:16` `16:9` `1:1` `4:5` | thường giữ theo việc |
| `targetSeconds` | số, tuỳ chọn | độ dài mong muốn của chủ kênh |
| `summary` | string 10–2000 | một đoạn tiếng Việt cho chủ kênh: dựng thế nào và vì sao. Không thuật ngữ kỹ thuật |
| `cutWords` | số nguyên[] | chỉ số từ bị bỏ. Nguồn sự thật của việc cắt |
| `gapMs` | số nguyên 0–5000 | khoảng lặng dài nhất được giữ giữa hai từ (ms); dài hơn thì cắt |
| `hook` | `{options, chosen}` | 1 đến 5 phương án, `chosen` là id được chọn. Xem `hooks.md` |
| `brolls[]` | xem `broll.md` | `id, anchorWord, duration (0.5–12s), title, reason, source (gồm pexels), assetId?, prompt?, layout (full/card/cutout), box? ({x,y,w,h} %), enabled` |
| `captions` | `{styleId, position, highlight[], maxWordsPerChunk}` | `position`: `bottom` `middle` `behind`. Xem `captions.md` |
| `overlays[]` | `{id, effect, anchorWord?, at, duration, props}` | `effect` là một trong 6 hiệu ứng dựng sẵn. Xem `effects.md` |
| `zooms[]` | `{at, duration, scale}` | `scale` 1.0–2.0, thường 1.08–1.2 để nhấn nhẹ |
| `music` | `{assetId, mood, gainDb, duck}` | `gainDb` chỉ là tinh chỉnh quanh 0; mức chuẩn lấy từ hồ sơ kênh. `duck: true` khi có giọng nói. Xem `audio.md` |
| `sfx[]` | `{at, assetId, gainDb?}` | mỗi tiếng động một điểm |
| `covers[]` | `{frameAt, title, subtitle?}` | tối đa 3 phương án, `frameAt` là giây video gốc. Xem `covers.md` |
| `meta` | `{title, caption, hashtags[], hook?}` | để đăng bài; không bịa, tối đa vài hashtag liên quan |
| `changes` | string[] | bản sửa (revise/marks): mỗi thay đổi một dòng. Với marks: bắt đầu bằng `[mark:<id>]` |

## Plan v2 (Dựng nhanh): các trường thêm

Mọi trường dưới đây đều tuỳ chọn: plan không có chúng là plan cũ, vẫn hợp lệ. Việc Dựng nhanh (chủ kênh đã chọn mẫu edit) thì **luôn** trả plan v2. Cách dùng mẫu: `templates.md`.

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `planFormat` | `2` | đánh dấu plan v2 |
| `templateId` | string | id mẫu chủ kênh chọn (ví dụ `th-vang`); không tự đổi mẫu |
| `autoCut` | boolean | `false` = chủ kênh tắt tự cắt: `cutWords` phải rỗng, không cắt gì |
| `beats[]` | track Chữ | `{id, component, anchorWord, at?, duration, kicker?, title, sub?, animIn?, sound?}`. `title` 2–6 từ, tối đa 2 dòng: `*từ*` tô nổi bật, `\|` xuống dòng |
| `scenes[]` | track Minh hoạ | `{id, component, anchorWord, at?, duration, props, animIn?, sound?}`; `props` đúng schema của component |
| `graphics[]` | track Đồ hoạ | `{id, component, anchorWord?, at?, duration, assetId?, props?, animIn?}` (ví dụ logo cuối) |
| `brolls[].hint` | string | mô tả chủ kênh gửi kèm tư liệu: chép nguyên vào B-roll dùng tư liệu đó |
| `brolls[].query` | `{description, keywords[]}` | chỗ trám cần máy tìm: mô tả tiếng Việt + 2–4 từ khoá **tiếng Anh**; để trống `assetId`, `source` là `pexels` |
| `brolls[].animIn`, `sound` | | như beats |
| `zooms[]` | `{id?, anchorWord?, at?, duration, scale}` | plan v2: đặt `anchorWord` thay cho `at` |

- `id`: duy nhất trong cả plan (`b1`.. chữ, `s1`.. minh hoạ, `g1`.. đồ hoạ, `z1`.. zoom, B-roll giữ id riêng). Bỏ trống thì máy tự đặt.
- `animIn`: id hiệu ứng vào **của mẫu**; `sound`: `{mode: "auto"|"none"|"asset", assetId?, volume}` (`auto` = tiếng của mẫu, `volume` 0–2).
- `origin`: không tự điền. Phần tử `origin: "owner"` là chủ kênh tự thêm; phần tử chủ kênh đã sửa tay được liệt kê riêng trong prompt. **Giữ nguyên id và nội dung** của chúng; máy cũng tự chép lại nếu plan mới làm mất.
- Máy kiểm tra: `component` và `animIn` có trong mẫu, props đúng kiểu và đủ trường bắt buộc, `anchorWord` không nằm trong `cutWords`. Chữ dài quá hoặc phần tử chồng thời gian trên cùng track chỉ là cảnh báo.

## Ví dụ đầy đủ

Lời chép giả định 160 từ, dài 70 giây. Mã kho (`assetId`) chỉ là ví dụ: luôn lấy từ `assets search`.

```json
{
  "styleId": "kienthuc",
  "aspect": "9:16",
  "targetSeconds": 60,
  "summary": "Giữ nguyên giọng nói tự nhiên, bỏ các từ đệm và hai câu nói lại, rút 70 giây còn khoảng một phút. Mở bằng con số giảm 50% thời gian, phụ đề 4 từ một lần và tô vàng các con số cùng tên công cụ. Nhạc nền nhỏ, một tiếng pop ở mỗi ý mới.",
  "cutWords": [3, 4, 17, 18, 19, 40, 41, 42, 43, 88, 89],
  "gapMs": 400,
  "hook": {
    "options": [
      { "id": "h1", "kind": "question", "text": "Bạn mất bao lâu để dựng một video?", "mode": "overlay" },
      { "id": "h2", "kind": "number", "text": "Giảm 50% thời gian dựng", "subtext": "chỉ với 3 bước", "mode": "overlay" },
      { "id": "h3", "kind": "story", "text": "Tôi từng dựng 6 tiếng cho 1 video", "mode": "moved", "moveFromWord": 96, "moveToWord": 109 }
    ],
    "chosen": "h2"
  },
  "brolls": [
    {
      "id": "b1",
      "anchorWord": 55,
      "duration": 2.5,
      "title": "Màn hình phần mềm dựng",
      "reason": "khi nói 'mở phần mềm dựng'",
      "source": "library",
      "assetId": "image:screen-editor",
      "layout": "card",
      "enabled": true
    }
  ],
  "captions": {
    "styleId": "caption:highlight-bar",
    "position": "bottom",
    "highlight": ["50%", "3 bước", "FreedomOS"],
    "maxWordsPerChunk": 4
  },
  "overlays": [
    { "id": "o1", "effect": "big-number", "anchorWord": 30, "at": 9.5, "duration": 2.5, "props": { "value": "50%", "label": "thời gian dựng" } },
    { "id": "o2", "effect": "stacked-list", "anchorWord": 60, "at": 27, "duration": 6, "props": { "title": "3 bước", "items": ["Tải video lên", "Duyệt kế hoạch", "Nhận bản dựng"] } },
    { "id": "o3", "effect": "cta-button", "anchorWord": 150, "at": 52, "duration": 3, "props": { "text": "Theo dõi để xem thêm" } }
  ],
  "zooms": [
    { "at": 9.5, "duration": 1.5, "scale": 1.12 }
  ],
  "music": { "assetId": "bgm:tap-trung-01", "mood": "Tập trung", "gainDb": 0, "duck": true },
  "sfx": [
    { "at": 9.5, "assetId": "sfx:pop", "gainDb": -8 },
    { "at": 27, "assetId": "sfx:pop", "gainDb": -8 }
  ],
  "covers": [
    { "frameAt": 3.2, "title": "Giảm 50% thời gian dựng", "subtitle": "3 bước đơn giản" },
    { "frameAt": 21.4, "title": "Dựng video nhanh gấp đôi" },
    { "frameAt": 44, "title": "Bạn đã thử chưa?" }
  ],
  "meta": {
    "title": "Giảm 50% thời gian dựng video chỉ với 3 bước",
    "caption": "Dựng video không cần mất cả buổi. 3 bước này giúp mình giảm một nửa thời gian. Bạn đang mất bao lâu cho mỗi video?",
    "hashtags": ["#dungvideo", "#meovat", "#freedomos"],
    "hook": "Giảm 50% thời gian dựng"
  },
  "changes": ["Bản đầu tiên"]
}
```

## Ví dụ plan v2 (Dựng nhanh, mẫu `th-vang`)

Cùng lời chép giả định. `br1` dùng tư liệu chủ kênh gửi (đúng `assetId`, chép `hint`); `br2` để máy tìm cảnh trám theo `query`.

```json
{
  "planFormat": 2,
  "templateId": "th-vang",
  "autoCut": true,
  "styleId": "kienthuc",
  "aspect": "9:16",
  "summary": "Bỏ từ đệm và một câu nói lại, giữ nhịp nói tự nhiên. Chữ vàng nhắc lại ý chính đúng lúc nói, một cảnh minh hoạ 3 bước khi liệt kê, một cảnh trám từ tư liệu bạn gửi và một cảnh máy tìm thêm.",
  "cutWords": [3, 4, 17, 18, 19],
  "gapMs": 400,
  "beats": [
    { "id": "b1", "component": "text-beat", "anchorWord": 8, "duration": 2.2, "kicker": "MẸO", "title": "Dựng video|*nhanh gấp đôi*", "animIn": "slide-up", "sound": { "mode": "auto", "volume": 1 } },
    { "id": "b2", "component": "text-beat", "anchorWord": 30, "duration": 2, "title": "Giảm *50%* thời gian", "animIn": "pop" }
  ],
  "scenes": [
    { "id": "s1", "component": "scene-steps", "anchorWord": 60, "duration": 6, "animIn": "fade", "props": { "step": 0, "title": "3 bước", "items": ["Tải video lên", "Chọn mẫu edit", "Bấm AI edit"] } }
  ],
  "graphics": [
    { "id": "g1", "component": "logo-end", "anchorWord": 150, "duration": 2.5, "animIn": "pop", "props": { "name": "Kênh của bạn", "cta": "Theo dõi để xem thêm" } }
  ],
  "brolls": [
    { "id": "br1", "anchorWord": 40, "duration": 2.5, "title": "Màn hình phần mềm dựng", "reason": "khi nói 'mở phần mềm dựng'", "source": "upload", "assetId": "a1b2c3d4", "hint": "quay màn hình lúc mở phần mềm", "layout": "card", "enabled": true },
    { "id": "br2", "anchorWord": 95, "duration": 2, "title": "Làm việc với laptop lúc tối", "reason": "khi nói 'ngồi dựng tới khuya'", "source": "pexels", "query": { "description": "người làm việc với laptop lúc tối", "keywords": ["laptop", "night", "working"] }, "layout": "full", "enabled": true }
  ],
  "captions": { "styleId": "bottom-clean", "position": "middle", "highlight": ["50%", "3 bước"], "maxWordsPerChunk": 3 },
  "zooms": [{ "id": "z1", "anchorWord": 30, "duration": 1.5, "scale": 1.1 }],
  "music": { "assetId": "bgm:tap-trung-01", "mood": "Tập trung", "gainDb": 0, "duck": true },
  "covers": [{ "frameAt": 3.2, "title": "Dựng video nhanh gấp đôi" }],
  "meta": { "title": "Dựng video nhanh gấp đôi với 3 bước", "caption": "3 bước để dựng một video nói chuyện trong vài phút. Bạn đang dựng mất bao lâu?", "hashtags": ["#dungvideo"] }
}
```

## Lỗi hay gặp (`plan validate` bắt được hầu hết)

- Chỉ số từ vượt phạm vi lời chép (`cutWords`, `anchorWord`, `moveFromWord`...). Lời có N từ thì chỉ số từ 0 đến N-1.
- Neo B-roll hay hiệu ứng vào từ đã cắt: cảnh chèn mất mốc.
- `hook.chosen` không trùng id nào trong `options`; hook `moved` thiếu `moveFromWord`/`moveToWord`.
- Đưa lại vào plan dữ liệu dẫn xuất (`keep`, `removed`, `outputDurationSec`): vô hại nhưng thừa, máy tính lại.
- `covers.frameAt` vượt độ dài video gốc, hoặc quá 3 bìa.
- Hiệu ứng không thuộc 6 loại dựng sẵn: renderer bỏ qua. Dùng đúng tên trong `effects.md`.
- Tự sửa chữ `keepWords` trong `props`, `highlight`, `meta`: luôn sai, kể cả khi nghĩ là "sửa lỗi chính tả".
- Plan v2: `component` hoặc `animIn` không có trong mẫu, thiếu prop bắt buộc (ví dụ `items` của `scene-steps`), id trùng giữa beats/scenes/B-roll, `autoCut: false` mà vẫn có `cutWords`, bịa `assetId` thay vì ghi `query`.
