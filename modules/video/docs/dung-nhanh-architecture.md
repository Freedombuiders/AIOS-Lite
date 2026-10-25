# Dựng nhanh: kiến trúc

Tab mới trong AI Video Studio: tải video quay thô, chọn một **mẫu edit**, bấm **AI edit**; AI dựng xong thì chủ kênh chỉnh tay trên timeline rồi xuất. Lấy cảm hứng từ một công cụ trình diễn trong video Reels (tải video → bật tự cắt → chọn mẫu → thêm tư liệu kèm mô tả → AI edit → chỉnh tay chữ, hiệu ứng vào, vị trí). Giao diện mẫu: `docs/mockups/*.dc.html` (7 màn).

Trạng thái: **đã chốt**. Kế hoạch giai đoạn 1 và hợp đồng dữ liệu: [dung-nhanh-gd1-plan.md](dung-nhanh-gd1-plan.md).

## Nguyên tắc

1. Nâng cấp module `video`, không làm module mới. Chuỗi máy có sẵn (ingest → transcribe → analyze → direct → approve → render → cover) được dùng lại.
2. HyperFrames là renderer duy nhất. **Agent không bao giờ viết HTML lúc chạy**: mẫu là các block làm sẵn, agent chỉ điền EditPlan JSON (chọn block, điền chữ, neo vào từ).
3. Việc nặng chạy trên máy (ffmpeg, whisper.cpp). Gửi lên model chỉ có chữ, vài khung hình và ảnh nhỏ.
4. Sửa tay của chủ kênh không bao giờ bị AI ghi đè.
5. Mọi tài nguyên lưu nguồn, tác giả, giấy phép.

## Sơ đồ

```
Trang đầu ─► Thiết lập ─► POST /projects/:id/ai-edit {mode, autoCut, cutLevel, templateId, assets[{assetId,hint}], music, stock, note}
                              │
  ingest (+HDR→SDR) → transcribe → analyze (+ từ đệm theo năng lượng) → speech-probe
                              │
              Asset Hub: tư liệu dự án (kèm mô tả) + Kho của tôi + nhạc/SFX theo mẫu → shortlist cho đạo diễn
                              │
          direct (đạo diễn) ◄── Template Pack: rules.md + danh sách component + schema props
                              │
              plan v2 (của AI)  ── resolve B-roll: Pexels/Kho → AI chấm 1–5 → tải về kho
                              │
                     overrides.json (của chủ kênh, tách riêng khỏi plan)
                              ▼
          Composition HyperFrames: block của mẫu, data-el-id, áp overrides sau mỗi khung, giảm nhạc khi có giọng
                              │
     Editor v2 ◄── hyperframes-player ──► /plan/ops · /overrides · Nhờ AI sửa (luồng marks/revise có sẵn)
                              │
     Dựng nháp 540p ─► QA máy + giám khảo AI (≤3 vòng) ─► Xuất 1080p + 3 bìa
```

## Sáu khối

### A. Template Pack (mẫu edit)

Một mẫu là một thư mục: `template.json` (thông tin, tags, tier, bộ font/màu, kiểu phụ đề, các component kèm schema props, preset hiệu ứng vào, luật SFX, giấy phép), các block HyperFrames (`components/*.html`, mỗi block là một sub-composition seek-safe), `rules.md` (luật cho đạo diễn: mật độ, độ dài chữ, khi nào dùng cảnh minh hoạ), `poster.webp`, `preview.mp4`.

- Mẫu cài sẵn: `modules/video/templates/<id>/`. Mẫu cài thêm: `<data>/video-edit/templates/<id>/`.
- 21 `VideoStyle` cũ được bọc thành mẫu cơ bản (id `style:<id>`), dùng 6 hiệu ứng overlay cũ, nên plan cũ vẫn chạy.
- Mẫu đầu tiên: **Talking head vàng** (`th-vang`): chữ Anton vàng theo nhịp nói, cảnh minh hoạ nền đen (các bước, trước–sau), zoom nhấn ý, SFX nhẹ.
- Runtime cho block: GSAP mặc định; được phép Lottie/dotLottie, Three.js, Anime.js, CSS, WAAPI, TypeGPU (đều có adapter seek-safe trong HyperFrames). Không số ngẫu nhiên chưa gieo hạt, không requestAnimationFrame/timer, không lặp vô hạn.

### B. Plan v2 và overrides

- EditPlan mở rộng (không viết lại): `templateId`, `autoCut`, `beats[]` (track Chữ), `scenes[]` (Minh hoạ), `graphics[]` (Đồ hoạ); B-roll thêm `hint`, `query`; mọi phần tử có `id`, `anchorWord`, `at`, `duration`, `animIn`, `sound`, `origin`. Các trường mới đều tuỳ chọn; plan cũ hợp lệ nguyên vẹn.
- `overrides.json` (cạnh `project.json`): chỉnh tay theo id phần tử (vị trí, cỡ, chữ, hiệu ứng vào, âm thanh, thời điểm, ẩn). AI không bao giờ ghi file này; composition áp nó lên plan. Phần tử chủ kênh tự thêm nằm trong plan với `origin: 'owner'` và được máy giữ lại khi AI sửa plan. Khi bản AI mới làm mất phần tử có override, editor báo và cho khôi phục.
- Thao tác cấu trúc (thêm, tách, khôi phục, bật/tắt từ) qua `POST /plan/ops`, gom vào bản nháp làm việc; chỉ tạo phiên bản plan mới khi xuất hoặc khi nhờ AI sửa.

### C. Pipeline AI edit

- `POST /projects/:id/ai-edit` lưu cài đặt vào `project.quick` rồi chạy chuỗi; AI edit không chờ duyệt plan (chỉ bấm Xuất mới render). `mode: 'manual'` ("Bỏ qua, tự chỉnh tay") bỏ bước đạo diễn, máy tạo plan `author: 'auto'`.
- Cắt: từ đệm theo năng lượng âm thanh (whisper hay bỏ "ừm/à"), luật cắt thô từng câu và chọn bản nói tốt nhất trong prompt đạo diễn, điểm cắt theo âm thanh thật (`speech-probe`). Tắt tự cắt thì `cutWords = []`.
- Chuẩn hoá thêm chuyển HDR sang SDR (video iPhone).
- Đạo diễn nhận: `rules.md` + component của mẫu, tư liệu kèm mô tả, shortlist nhạc/SFX/kho, ghi chú. Trả plan v2.

### D. Asset Hub

- Nguồn theo thứ tự: tư liệu dự án → Kho của tôi → Pexels video → Pexels ảnh. Mỗi nguồn là một provider chung giao diện, ứng viên luôn kèm giấy phép, tác giả, link gốc.
- Lập chỉ mục: AI xem 2–6 khung để viết mô tả tiếng Việt và chấm chất lượng 0–1; nhạc được máy đo BPM và nhịp mạnh, AI gắn mood/thể loại/có lời.
- Chọn cảnh trám: đạo diễn ghi mô tả + 2–4 từ khoá tiếng Anh cho mỗi chỗ trám; máy tìm, AI nhìn ảnh nhỏ và chấm 1–5 theo câu đang nói, giữ từ 3 trở lên, tránh hai cảnh giống nhau liền nhau, rồi tải về kho.
- Sửa lỗi hiện tại: đạo diễn không còn đoán mã tài nguyên; chỉ chọn trong shortlist có `assetId` thật.
- Nhạc: Kho của tôi + nhạc CC0 có sẵn. Không cào Pixabay Music.

### E. Composition và Editor v2

- Composition dựng block của mẫu cho beats/scenes/graphics/B-roll, gắn `data-el-id` cho mọi phần tử, áp overrides sau mỗi lần seek (dùng thuộc tính CSS `translate`/`scale` riêng nên cộng vào hiệu ứng của block). Phụ đề theo kiểu của mẫu. Giảm nhạc khi có giọng bằng tự động hoá âm lượng của HyperFrames (bản xem trước và bản xuất giống nhau). Kiểm tra font đã nạp đủ dấu.
- Editor v2 (theo mockup màn 4): thanh công cụ, inspector sinh form từ schema props, preview, danh sách lớp, timeline nhiều track. GĐ1: chọn phần tử trên timeline, sửa chữ/hiệu ứng vào/âm thanh/cỡ, xuất. GĐ2: kéo/phóng trên preview, kéo/tách/xoá trên timeline, hoàn tác/làm lại, thư viện kéo thả.

### F. QA (GĐ2)

Máy đo trên bản nháp (độ dài, LUFS/đỉnh, tiếng bụp ở điểm cắt, khung nháy, đồ hoạ đứng yên, phụ đề che mặt, font, vùng an toàn) và giám khảo AI là agent khác đạo diễn (GIỮ/SỬA kèm mốc), tự sửa tối đa 3 vòng.

## Quyết định đã chốt

| Vấn đề | Chốt |
|---|---|
| Vị trí | Tab mới "Dựng nhanh"; luồng chat "Video quay sẵn" giữ nguyên |
| Duyệt plan | AI edit dựng thẳng; chỉ bấm Xuất mới render |
| Sửa tay | `overrides.json` tách riêng; phần tử chủ kênh thêm có `origin: 'owner'` |
| EditPlan | Mở rộng, các trường mới tuỳ chọn |
| Nhạc | Kho của tôi + CC0 có sẵn + bài chủ kênh thêm; nhạc AI để GĐ3 |
| Stock | Pexels ở GĐ1; Pixabay tuỳ chọn ở GĐ3 |
| Model nhìn ảnh | Agent qua `ctx.agents.runLean` (cấu hình đổi được) |
| FREE/PRO | Có trường `tier`, chưa khoá |
| Ghi âm trong tư liệu | GĐ1 chỉ nhận ảnh và video; ghi âm làm ở GĐ2 khi chốt cách dùng |

## Học từ mã nguồn mở

Chép mã thì ghi vào `THIRD_PARTY_NOTICES.md`. Chỉ học ý tưởng thì tự viết lại.

| Nguồn | Giấy phép | Dùng cho | Cách lấy |
|---|---|---|---|
| openfilm | MIT | Lớp overrides, phát hiện sửa tay bị mất, ops + hoàn tác theo id, chọn trên preview, luật timeline, schema props và kiểu phụ đề | Mã |
| open-edit | Apache-2.0 | `speech-probe`, `whisper-mapper`, danh sách hiệu ứng chữ | Mã |
| FireRed-OpenStoryline | Apache-2.0 | Prompt cắt thô từng câu, dò nhịp mạnh và hít theo nhịp, AI nghe nhạc gắn nhãn, mô tả clip, gợi ý từ kho | Mã |
| video-use | MIT | HDR→SDR, chia phụ đề, kiểm tra font, ảnh soát quanh điểm cắt, luật chọn take | Mã |
| motion-video-kit | MIT | Giám khảo AI, đo loudness và hình đứng yên, luật nhạc | Mã |
| autocut | Apache-2.0 | Chế độ danh sách câu trong lời chép, VAD trước whisper | Ý tưởng |
| OpenMontage | AGPL-3.0 | Thiết kế Asset Hub (mô tả để chấm, từ khoá để tìm, chấm 1–5, tránh trùng), số liệu âm thanh, phân tích video tham khảo | Chỉ ý tưởng |
| html-video, forever-ai-components | Apache-2.0, MIT | Cấu trúc `template.json`, ghi chú cho agent và chỉ mục component | Ý tưởng |
| awesome-hyperframes-prompt, awesome-claude-video | Không giấy phép | Kiểu phụ đề, cảnh trước–sau, cảnh các bước, bố cục người nói hình tròn | Chỉ ý tưởng |
| GSAP, dotLottie, Three.js, Anime.js, SVGO, Mediabunny, gsap-skills | Xem từng repo | Runtime cho block, tối ưu SVG, dải khung hình trên timeline, agent làm hiệu ứng | Thư viện |

Không dùng: Remotion (engine khác, giấy phép công ty), Motion Canvas, R3F/Drei/Rapier (lớp React), Motion, Howler, react-bits (giấy phép cấm phân phối lại bản port).

## Giai đoạn

- **GĐ1:** khối A, B, C đầy đủ; D (Kho của tôi có lập chỉ mục, Pexels, nhạc có nhịp, giảm nhạc khi nói); E cơ bản; màn Trang đầu, Thiết lập, Đang dựng, Editor. Xong khi video mẫu 28 giây ra bản dựng có chữ theo nhịp, cảnh trám từ tư liệu và Pexels, nhạc giảm khi nói, sửa tay rồi nhờ AI sửa mà không mất phần đã sửa, và xuất được MP4.
- **GĐ2:** Editor đầy đủ (kéo/phóng, timeline sửa được, hoàn tác/làm lại, thư viện kéo thả, đổi cảnh khác), QA + giám khảo, Dựng nháp, chế độ danh sách câu, ghi âm, sticker dotLottie.
- **GĐ3:** tạo mẫu từ video tham khảo, lưu cách edit thành mẫu, Xưởng hiệu ứng (agent viết block mới, máy kiểm tra seek-safe), thêm mẫu (3D, shader, chuyển cảnh), Pixabay, Freesound, B-roll do AI tạo.
