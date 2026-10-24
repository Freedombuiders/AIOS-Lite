> Tài liệu thiết kế của bản gốc (ClaudeClaw). Trong AIOS-Lite lượt đạo diễn không còn video-cli hay cổng MCP: xem PORTING.md.

# Video Studio v3: một không gian, một Đạo diễn AI

Cập nhật 2026-10-20. Video Studio là trung tâm sản xuất nội dung. KOL Studio chỉ tạo và huấn luyện nhân vật (khuôn mặt, ảnh gốc, hồ sơ, giọng văn). Video Studio gọi nhân vật bằng `@` và làm video từ ý tưởng tới bài đăng nháp.

## Ba tab

| Tab | Làm gì |
|---|---|
| **Studio** (mặc định, `/video-studio`) | Không gian ba khung: danh sách video bên trái, canvas ở giữa, Đạo diễn AI bên phải. `?p=<productionId>&v=board\|preview\|finish` mở một video. |
| **Video quay sẵn** (`?tab=edit`, `?project=…&view=editor`) | Trình dựng HyperFrames cho video đã quay: phụ đề tô từ khoá, hook, hiệu ứng theo lời, zoom, nhạc, ảnh bìa, xuất MP4. |
| **Kết nối** (`?tab=connect`) | Trạng thái từng công cụ và cách sửa. Giọng HeyGen và bộ nhận diện của từng KOL. Quyền RocketFlow. |

Link cũ vẫn chạy: `?tab=create`, `?tab=flow`, `?tab=studio` mở Studio. Tab "Tạo video mới" cũ (`CreateVideoPanel`, `FlowStudioPanel`) đã bỏ; RocketFlow giờ là một công cụ tạo cảnh. Route `/creation/*` vẫn giữ để tương thích.

## Không gian Studio

```
┌ Danh sách ────────┐┌ Canvas ─────────────────────────────┐┌ Đạo diễn AI ───────────────┐
│ Video mới · Quay  ││ Tên · KOL · khung · trạng thái       ││ Chat, gọi @KOL, lệnh nhanh │
│ sẵn · tìm · lọc   ││ Phân cảnh ⇄ Xem thử ⇄ Hoàn thiện      ││ theo ngữ cảnh. Agent gọi   │
│ AI sản xuất +     ││ Nút chính đổi theo bước: Xin duyệt & ││ công cụ, hiện từng bước,   │
│ quay sẵn chung    ││ tạo N cảnh → Hoàn thiện → Đăng lên KOL││ thẻ duyệt chi phí ngay     │
│ một danh sách     ││ Thẻ duyệt, tiến độ, chi phí còn lại   ││ trong chat                 │
└───────────────────┘└───────────────────────────────────────┘└────────────────────────────┘
```

- **Không có video nào đang mở:** canvas hiện ô soạn ý tưởng: `@KOL`, khung hình, thời lượng, 1 video hoặc series 3/5/7. Bấm "Bắt đầu với Đạo diễn AI" tạo video và mở ngay một lượt agent.
- **Phân cảnh:** thẻ duyệt đang chờ, thanh tiến độ, chi phí còn lại, hook, thẻ từng cảnh (loại, KOL, ảnh mặt, lời, bối cảnh, công cụ, "Xin duyệt" riêng một cảnh), thêm cảnh, chú thích và hashtag, ý tưởng gốc.
- **Xem thử:** phát nối tiếp các cảnh đã xong bằng hai `<video>` luân phiên, một thanh tua chung cho cả video (`previewPlaylist`, `locateAt`).
- **Hoàn thiện:** ghép rồi nhúng thẳng trình dựng HyperFrames (`EditorView embedded`) và phiếu dựng. Khi có bản xuất thì hiện video, chọn KOL đăng, nút "Đăng lên KOL" và tải MP4.
- **Màn nhỏ:** từ 1200 px trở xuống, khi đang mở video thì danh sách thành ngăn kéo. Từ 980 px trở xuống (điện thoại), Đạo diễn AI thành tấm trượt từ đáy lên.

## Mô hình dữ liệu

Mỗi video là một `Production` (`production.json`: kịch bản và phân cảnh) gắn một-một với một **dự án chủ** `VideoProject` có `mode: 'produce'` và `productionId`. Dự án chủ dùng lại toàn bộ cơ chế của trình dựng: chat, lượt agent, khoá đang bận, SSE, phiên engine, `/style`, đính kèm. Hoàn thiện dùng lại chính dự án đó (`finishProjectId === projectId`), không tạo dự án con. Production cũ có `finishProjectId` thì nhận dự án đó làm chủ khi mở (`ensureHost`). Dự án chủ không hiện trong danh sách "quay sẵn", và `/upload` vào dự án chủ trả 409.

## Đạo diễn AI

Trong panel Đạo diễn AI, chọn **Nguồn AI → ChatGPT (đăng nhập)**, chọn model và bấm **Dùng model này**. **Theo agent** dùng lại provider đã cấu hình của agent. Lựa chọn được lưu riêng trong `VideoProject.directorProvider`; đổi nguồn/model xoá phiên engine cũ, giữ nguyên tin nhắn, persona và quyền công cụ. Không thể đổi trong lúc agent đang chạy.

Nếu chưa kết nối, bấm **Đăng nhập ChatGPT**, mở trang OpenAI và nhập mã thiết bị. Luồng dùng CLI Codex đi kèm (`codex login --device-auth`), lưu credential trên máy chủ; trình duyệt chỉ nhận link và mã một lần. Có nút huỷ và kiểm tra lại. Nếu tài khoản chưa bật device login, bật trong bảo mật ChatGPT hoặc chạy `codex login` trên máy chủ. Xem [hướng dẫn xác thực OpenAI](https://developers.openai.com/codex/auth).

Lượt chọn ChatGPT bắt buộc dùng xác thực ChatGPT, dùng home Codex riêng và loại bỏ API key khỏi môi trường của lượt đó; SDK và App Server đều áp dụng. Danh sách model lấy từ cache tài khoản Codex, dự phòng bằng catalog chung của ứng dụng; model thực sự được phép dùng vẫn phụ thuộc tài khoản và hạn mức ChatGPT.

`runDirectorTurn` với lý do `'produce'`, chạy khi dự án chủ chưa có video nguồn. Agent nhận skill `skills/video-produce/SKILL.md` và một gateway MCP riêng cho từng lượt, tên `video-produce` (`hostTask: 'video-produce'`, hồ sơ ngữ cảnh `standard`). Chỉ agent chủ, không phải agent tin cậy thấp, mới được mở gateway.

| Công cụ | Làm gì |
|---|---|
| `produce_context`, `produce_status` | Đọc ý tưởng, KOL (giọng, bộ nhận diện, ảnh), công cụ đang bật, phân cảnh, thẻ duyệt đang chờ |
| `produce_update_brief` | Đổi tiêu đề, ý tưởng, KOL, khung, thời lượng |
| `produce_write_storyboard` | Gọi bộ não KOL viết kịch bản đúng giọng nhân vật |
| `produce_set_storyboard` | Agent tự đặt toàn bộ kịch bản và phân cảnh |
| `produce_add_scene`, `produce_update_scene`, `produce_move_scene`, `produce_remove_scene` | Sửa từng cảnh |
| `produce_estimate` | Ước tính chi phí |
| `produce_request_generation` | Gửi **một** thẻ duyệt cho cả lô. Không bao giờ tự tạo cảnh. Agent kết thúc lượt ngay sau đó |
| `produce_finish` | Ghép và chuyển sang hoàn thiện, chạy nền |

Khi các cảnh của lô đã chạy xong, máy chủ nhắn hệ thống vào chat và mở một lượt `produce` mới để agent báo kết quả. Sau khi hoàn thiện, agent dùng tiếp `video-cli` sẵn có để lên kế hoạch dựng, và kế hoạch đó vẫn chờ chủ duyệt.

Đã thử thật ngày 20/10: agent gọi `produce_context` và `produce_estimate`, trả bảng phân cảnh và chi phí ($3,00 cho 5 cảnh Veo), giải thích vì sao 3 cảnh trước đó lỗi, và không sửa gì khi được yêu cầu chỉ xem.

## Duyệt chi phí theo lô

- `POST /productions/:id/generate` (hoặc công cụ `produce_request_generation`) kiểm tra từng cảnh. Cảnh nào còn vấn đề thì bị từ chối kèm lý do. Nếu không có cảnh nào bị từ chối, hệ thống tạo approval loại `video_generate`, khoá chống trùng `video_generate:<id>:<fingerprint>`, hết hạn sau 24 giờ.
- Thẻ hiện ở ba nơi: trong chat và trên canvas (`ApprovalCard`), ở "Cần tôi", và trên Telegram. Hành động là "Duyệt và tạo" hoặc "Không tạo".
- Duyệt thì máy chủ so lại **fingerprint** (sha256 của các cảnh trong lô). Sửa một cảnh đang chờ duyệt làm thẻ hết hiệu lực, và phải xin lại. Tạo lại một cảnh cũng phải xin duyệt.
- Cách ước tính (`estimate.ts`), không bịa số:
  - Veo: $0,15/giây, làm tròn lên 4, 6 hoặc 8 giây.
  - fal: 5, 10 hoặc 15 giây, giá lấy từ `unitPriceUsd`.
  - HeyGen: khoảng 26 credit cho mỗi phút lời nói (`VIDEO_STUDIO_HEYGEN_CREDITS_PER_MIN`).
  - RocketFlow: tính theo credit Google Flow.
  - Pexels và clip có sẵn: miễn phí.
- Sau khi duyệt, mọi cảnh có tốn tiền vẫn đi qua hạn mức của KOL Studio (`admission` / `recordSpend`), và cảnh có KOL vẫn đi qua bước kiểm tra danh tính.
- Khởi động lại: cảnh `queued` chuyển thành lỗi, cảnh `running` tiếp tục được theo dõi.

## Công cụ tạo cảnh

| Loại cảnh | Công cụ | Ghi chú |
|---|---|---|
| KOL nói | **HeyGen** | Ảnh KOL đã duyệt, giọng gán ở Kết nối (Avatar IV qua API v3, khớp khẩu hình, không giới hạn độ dài) |
| KOL nói | Veo 3.1 | Câu ngắn ≤ 8 giây. Veo chặn khuôn mặt người thật (Tony), nên dùng HeyGen cho KOL là người thật |
| B-roll | Veo / fal | Giữ đúng mặt khi có KOL |
| B-roll | **Pexels** | Cảnh quay thật miễn phí, đúng khung hình, ghi tên tác giả (`output.credit`) |
| B-roll | RocketFlow | Google Flow qua tiện ích Chrome |
| Clip có sẵn | Không tạo mới | Lấy video trong thư viện KOL |

Khi B-roll không có KOL, công cụ được chọn theo thứ tự Veo, rồi Pexels, rồi RocketFlow, tuỳ cái nào đang kết nối. Kịch bản có hai KOL thì viết dạng hội thoại, mỗi cảnh một người nói.

## Bộ nhận diện theo KOL

Lưu tại `STORE_DIR/video-edit/kol-brand.json`, sửa ở Kết nối. Gồm: phong cách hoàn thiện mặc định, nhạc nền (Đạo diễn AI tự chọn hoặc không dùng), CTA luôn dùng, câu mở, câu kết, kiểu phụ đề. Người viết kịch bản dùng intro, CTA và outro. Khi hoàn thiện, video nhận `styleId`, và tin nhắn gửi agent dựng mang theo kiểu phụ đề và nhạc.

## Series

`POST /productions/series` với `count` 3, 5 hoặc 7. Bộ não KOL chia ý tưởng thành từng góc khai thác (`planSeries`). Mỗi video là một production có `series {id, index, total}`, và lần lượt chạy một lượt Đạo diễn AI.

## Đăng lên KOL

`POST /projects/:id/publish` thực hiện ba bước:

1. Chép bản xuất mới nhất vào thư viện KOL (`importAssetFromUpload`, trạng thái approved, tag `video-studio`).
2. Tạo bài **nháp** (`createPost`, `source: 'owner'`). Khung 9:16 tạo dạng reel, khung khác tạo dạng video. Chú thích và hashtag lấy từ kịch bản.
3. Ghi `project.published`.

Lệnh này không đăng gì công khai: chủ duyệt, chọn kênh và lên lịch trong KOL Studio. Gọi lại với cùng KOL và cùng phiên bản thì trả về bài đã có.

## Kết nối cần có

| Công cụ | Cách bật |
|---|---|
| HeyGen | Integrations › HeyGen (API key, chủ tự dán). Gán giọng ở Kết nối, ví dụ "TonyTrieu" |
| Veo 3.1 | `GOOGLE_API_KEY` trong `.env` (đã có) |
| Pexels | Integrations › Pexels (tuỳ chọn, miễn phí) |
| fal.ai | Integrations › fal.ai |
| RocketFlow | Cài tiện ích và MCP server, đặt `ROCKETFLOW_MCP_SERVER`, khởi động lại |
| HyperFrames | `npx hyperframes`, khoá phiên bản 0.8.156 (`VIDEO_EDIT_HF_VERSION`), cần Chrome |
| Whisper | Chỉ cần cho video quay sẵn: model `ggml-*.bin` trong `~/.cache/whisper-cpp` |

## Code

| Phần | Nơi |
|---|---|
| Server | `src/video-edit/production/`: `service`, `routes`, `runtime`, `approval`, `estimate`, `tools` (MCP), `prompt`, `publish`, `series`, `engines`, `writer`, `store`, `heygen`, `kol-bridge`, `assemble` |
| Agent | `src/video-edit/agent/director.ts` (lý do `produce`), `skills/video-produce/SKILL.md`, `hostTask` trong `agent-engine/types.ts`, `codex-capability-policy.ts`, `agent-context.ts` |
| Duyệt | Loại `video_generate` trong `approvals/contract.ts`, `approvals/routes.ts`, `web/src/lib/approvals-view.ts` |
| Giao diện | `web/src/components/video-studio/studio/*` (`StudioWorkspace`, `ProductionCanvas`, `DirectorPanel`, `ApprovalCard`, `ScenePreviewPlayer`), `production/*`, `web/src/lib/video-production*.ts`, `web/src/styles/video-production.css` (tiền tố `vx-`) |
| Test | `production.test.ts`; `web/src/lib/video-production.test.ts`, `studio-tabs.test.ts`; `e2e/video-studio.spec.ts` |

## Bản 3.1: chắc chắn và mượt (21/10)

Sửa sau một vòng chạy thật và soát code.

**An toàn chi phí và độ bền**
- Xoá video khi đang tạo cảnh bị từ chối (409). Trước đây việc này làm sập cả app vì lỗi không được bắt.
- Thẻ duyệt hết hạn hoặc lỗi được dọn tự động (`sweepApprovals`, mỗi 8 giây), không còn kẹt "Chờ duyệt".
- Chỉ thẻ duyệt hiện hành mới chạy được. Dấu vân tay tính cả khung hình và giọng HeyGen; khuôn mặt được chốt trước khi xin duyệt.
- Không được đổi khung hình khi đã có cảnh được tạo.
- Cảnh đang tạo có trần thời gian: HeyGen 45 phút, Veo 30 phút, KOL Studio 90 phút. Sau 15 lần không theo dõi được thì báo lỗi. Hệ thống không bao giờ gửi lại một job có thể vẫn đang chạy.
- Veo B-roll ghi chi phí đúng một lần cho mỗi job.
- Hạn mức của KOL Studio tính cả các cảnh đang chạy.
- **Nhà cung cấp quá tải** ("high demand", 429/503): yêu cầu bị từ chối, chưa tạo gì, chưa tính phí. Cảnh tự thử lại sau 1, 3, 8 rồi 15 phút mà không cần duyệt lại. Có nút "Dừng tự thử lại". Lỗi do bộ lọc an toàn không bao giờ được thử lại.
- **KOL người thật** (`identity_source = licensed`, ví dụ Tony): Veo bị chặn ngay từ trước khi xin duyệt, kèm lý do. Cảnh nói phải dùng HeyGen. Tên người thật được thay bằng "the presenter" trong mọi câu lệnh gửi Veo hoặc Flow. Bộ viết kịch bản không đặt người thật vào B-roll.
- "Tạo lại" là một yêu cầu mới (số lần tạo nằm trong khoá chống trùng HeyGen; với stock thì lấy kết quả kế tiếp).
- Gọi nhà cung cấp, tải file và ghép video đều chạy ngoài khoá, nên việc sửa không bị treo. Ghép lỗi có lý do hiện trong chat và nút "Ghép lại". Nếu máy khởi động lại giữa lúc ghép, video được đưa về trạng thái thử lại được.
- Tiêu đề bạn đặt được giữ nguyên, bộ viết kịch bản không đổi.

**Cắt cảnh**
- Mỗi cảnh có `trimStart` và độ dài phát (`output.durationSec`); `output.sourceSec` là độ dài cả file.
- Stock và clip có sẵn tự cắt về độ dài của cảnh.
- Cắt trên thẻ cảnh hoặc bằng `produce_trim_scene` đều miễn phí. Bản xem thử và bản ghép tôn trọng điểm cắt, phụ đề SRT được dời theo.

**Đạo diễn AI**
- Công cụ mới:
  - `produce_list_media`: ảnh có nhãn "trang phục · bối cảnh · tư thế" và điểm khớp mặt; video ghi rõ dùng cho `clipAssetId`.
  - `produce_inspect_scene`: trả ảnh 4 khung hình để agent tự nhìn cảnh.
  - `produce_trim_scene`.
- `produce_set_storyboard` gộp vào cảnh có sẵn: trường bỏ trống thì giữ nguyên, nên không xoá mất cảnh đã tạo. Công cụ dựng luôn hợp lệ với loại cảnh.
- Cảnh clip: id ghi nhầm vào ô khuôn mặt tự chuyển sang ô clip. Clip mặc định phát đủ độ dài.
- Kịch bản viết lâu quá 95 giây thì chạy tiếp ở nền rồi báo trong chat.
- Khi đánh thức agent gặp lúc nó đang bận, hệ thống thử lại ở vòng sau.
- Ở giai đoạn hoàn thiện, agent vẫn có công cụ sản xuất: "tạo lại cảnh 3" vẫn xin duyệt, rồi `produce_finish` ghép lại.
- Lượt chat ở giai đoạn sản xuất bật suy nghĩ thích ứng.
- Đã thử thật: agent đọc ảnh/clip, chuyển cảnh Tony sang HeyGen, gọt về 30 giây và hạ chi phí từ $4,80 xuống $1,80. Sau đó nó xem 4 khung hình của cảnh clip, nhận xét đúng trang phục, bối cảnh, phụ đề có sẵn và câu bị cắt giữa chừng, rồi đề xuất bỏ cảnh lặp ý. Toàn bộ không tốn tiền.

**Giao diện**
- Một luồng sự kiện cho mỗi video (luồng của dự án chủ). Danh sách tự cập nhật theo sự kiện, còn hỏi định kỳ chỉ mỗi 30 giây.
- Máy chủ chỉ lưu và phát sự kiện khi có thay đổi. Chi phí chỉ tính lại khi phân cảnh thật sự đổi.
- Video Studio tải lười: bundle chính giảm 204 KB.
- Sửa cảnh đi qua hàng đợi lưu riêng: không mất thay đổi, có báo "Đang lưu / Đã lưu".
- Nút chính chỉ xin duyệt những cảnh tạo được và hiện số cảnh cần sửa.
- Trả lời của agent hiển thị markdown. Các bước của agent ghi bằng tiếng Việt (đã gộp dòng bắt đầu và dòng kết thúc).
- Chọn giọng HeyGen: có cả giọng tiếng Việt sẵn có của HeyGen và nút nghe thử.
- Trên điện thoại, tấm chat dùng được bằng bàn phím (`aria-expanded`, `inert` khi thu gọn, `dvh`).
- Thẻ duyệt báo lỗi khi không tải được, nhãn trạng thái đúng.

## Chưa làm

- Chạy thật trọn một video có tốn tiền: cần dán khoá HeyGen, gán giọng, rồi duyệt một lô.
- Ghi nhớ gu và bài học theo từng KOL từ số liệu đăng bài.
- Bảng chi phí thực tế theo từng video (hiện chỉ có ước tính trước khi duyệt).
- Lời dẫn (voice-over) chạy xuyên qua các cảnh B-roll: cần HeyGen hoặc ElevenLabs.
- Cho chọn giữa nhiều kết quả Pexels (hiện mỗi lần tạo lại lấy kết quả kế tiếp).
- Hạn mức tiêu credit HeyGen (credit trừ thẳng vào gói HeyGen, không qua sổ chi của KOL Studio).
