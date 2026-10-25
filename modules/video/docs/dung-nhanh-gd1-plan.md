# Dựng nhanh · Giai đoạn 1: kế hoạch và hợp đồng

Đọc trước: [dung-nhanh-architecture.md](dung-nhanh-architecture.md). Giao diện mẫu: `docs/mockups/*.dc.html` (Main = Trang đầu, Setup = Thiết lập, Progress = Đang dựng, Editor, Library, Music, QA). Mockup là HTML tĩnh kèm logic nhỏ; dùng làm chuẩn bố cục, chữ và luồng, không chép nguyên mã.

Nhánh tích hợp: `feat/video-dung-nhanh`. Mỗi việc làm trên worktree riêng tách từ nhánh này, commit trên nhánh của việc đó, không push. Điều phối viên gộp từng đợt vào nhánh tích hợp.

## Quy ước chung cho mọi việc

- Chữ hiển thị cho người dùng bằng tiếng Việt, ngắn, rõ, theo giọng hiện có của module (`README.md`, `TemplateStart.tsx`). Không dùng thuật ngữ kỹ thuật trên UI.
- Code giống code xung quanh: TypeScript ESM, `zod` cho kiểm tra đầu vào, Hono routes theo mẫu `registerEditorRoutes(app, deps)` trong `server/edit/routes-editor.ts`, Preact + signals ở web (`web/lib/video-edit/studio.ts`), class CSS tiền tố `vs-` và màu lấy từ biến theme (`--color-*`, `--vs-highlight`).
- Không sửa ngoài phạm vi file của việc mình. Cần đổi file của việc khác thì hỏi điều phối viên.
- Không đụng `full_crm/Rocketchat` hay module khác ngoài `modules/video` (trừ `THIRD_PARTY_NOTICES.md` khi chép mã có giấy phép).
- Chép mã từ repo mã nguồn mở: chỉ từ repo MIT/Apache-2.0 trong bảng ở tài liệu kiến trúc, giữ ghi chú bản quyền ở đầu file và thêm một mục vào `THIRD_PARTY_NOTICES.md`. OpenMontage (AGPL) và repo không giấy phép: chỉ học ý tưởng. Bản clone để đọc (chỉ đọc, không cài, không chạy): `/private/tmp/claude-501/-Users-tonyhoang-Developer-GitHub-AIOS-Lite/71e1f1bb-24fc-4bb8-adfc-72e0a8db052e/scratchpad/oss/<repo>`; nếu không đọc được thì `git clone --depth 1` vào thư mục tạm của bạn.
- Không gọi dịch vụ thật trong test (Pexels, model): dùng fake như test hiện có.
- Kiểm tra trước khi báo xong: `npx vitest run modules/video` và `npm run typecheck`. Mốc trước khi sửa: 238/239 test qua; `server/actions.test.ts > create.call only works…` hết giờ sẵn từ trước, không cần sửa.
- Worktree mới chưa có `node_modules`: tạo symlink `ln -s /Users/tonyhoang/Developer/GitHub/AIOS-Lite/node_modules node_modules` ở gốc worktree nếu thiếu.

## Hợp đồng dữ liệu

Các kiểu dưới đây là hợp đồng giữa các việc. Việc T1 hiện thực chúng; các việc sau dùng đúng tên và hình dạng này.

### Plan v2 (`server/edit/types.ts`, bản sao ở `web/lib/video-edit/types.ts`)

```ts
export type ElementOrigin = 'ai' | 'owner';

export interface ElementSound {
  mode: 'auto' | 'none' | 'asset';   // auto = theo luật sounds của mẫu
  assetId?: string;                   // mode asset: sfx trong kho
  volume: number;                     // 0..2, 1 = mức mặc định của mẫu
}

export interface ElementBase {
  id: string;            // duy nhất trong plan: beat 'b1'.., scene 's1'.., graphic 'g1'.., broll giữ id cũ, zoom 'z1'..
  anchorWord?: number;   // chỉ số từ trong lời chép; máy dời `at` khi danh sách cắt đổi
  at: number;            // giây trong video đã dựng
  duration: number;      // giây
  animIn?: string;       // id preset hiệu ứng vào của mẫu ('typewriter' | 'slide-short' | 'slide-up' | 'pop' | 'fade' ...)
  sound?: ElementSound;
  origin?: ElementOrigin; // mặc định 'ai'
}

export interface TextBeat extends ElementBase {
  component: string;     // id component trong mẫu, mặc định 'text-beat'
  kicker?: string;       // nhãn nhỏ, ví dụ "BƯỚC 1"
  title: string;         // markup: *từ* = tô nổi bật, | = xuống dòng; 2–6 từ, tối đa 2 dòng
  sub?: string;          // chữ phụ
}

export interface SceneItem extends ElementBase {
  component: string;     // ví dụ 'scene-steps' | 'scene-before-after'
  props: Record<string, string | number | string[]>;  // theo schema props của component
}

export interface GraphicItem extends ElementBase {
  component: string;     // ví dụ 'logo-end'
  assetId?: string;
  props?: Record<string, string | number | string[]>;
}

// EditPlan: thêm các trường TUỲ CHỌN (plan cũ vẫn hợp lệ)
export interface EditPlan {
  // ...các trường hiện có...
  planFormat?: 2;
  templateId?: string;
  autoCut?: boolean;
  beats?: TextBeat[];
  scenes?: SceneItem[];
  graphics?: GraphicItem[];
}

// BrollItem: thêm
//   hint?: string;                                        // mô tả chủ kênh gửi kèm tư liệu
//   query?: { description: string; keywords: string[] };  // đạo diễn ghi cho chỗ trám cần tìm (keywords tiếng Anh, 2–4)
//   animIn?: string; sound?: ElementSound; origin?: ElementOrigin;
// zooms[]: thêm id?: string; anchorWord?: number; origin?: ElementOrigin
```

Luật kiểm tra (validator trong `pipeline/plan.ts`): id duy nhất; `anchorWord` trong phạm vi và không nằm trong `cutWords`; `component` và `animIn` phải có trong mẫu `templateId` (nếu mẫu có trong registry); props đúng schema của component; `title` 2–6 từ, tối đa 2 dòng (cảnh báo, không chặn); `autoCut === false` thì `cutWords` phải rỗng; phần tử chồng thời gian trên cùng track thì cảnh báo.

### Overrides (`<data>/video-edit/projects/<id>/overrides.json`)

```ts
export interface ElementOverride {
  t?: [number, number];        // dời vị trí, % của khung (x, y)
  s?: number;                  // nhân cỡ, 1 = không đổi
  text?: { kicker?: string; title?: string; sub?: string };
  props?: Record<string, string | number | string[]>;
  animIn?: string;
  sound?: ElementSound;
  at?: number;
  duration?: number;
  hidden?: boolean;            // chủ kênh xoá một phần tử của AI
  updatedAt: string;
}

export interface OverridesDoc {
  version: 1;
  elements: Record<string, ElementOverride>;   // khoá = id phần tử
  captions?: Partial<CaptionStyle>;            // kiểu phụ đề chủ kênh chỉnh (CaptionStyle: xem Template)
  updatedAt: string;
}
```

- AI không bao giờ ghi file này. Prompt đạo diễn liệt kê các phần tử đã có override như dữ liệu chỉ đọc: "chủ kênh đã sửa tay, giữ nguyên id".
- Khi đạo diễn nộp plan mới: máy chép lại mọi phần tử `origin: 'owner'` mà plan mới thiếu (ghi vào `changes`); phần tử AI có override mà plan mới bỏ mất được liệt kê ở `GET /overrides` dưới `dropped: { id, kind, label, fromVersion }[]` để editor hiện nút khôi phục.

### Thao tác plan (`POST /projects/:id/plan/ops`)

```ts
type PlanOp =
  | { op: 'add'; kind: 'beat' | 'scene' | 'graphic' | 'broll' | 'zoom'; element: object }   // máy gán id, origin 'owner'
  | { op: 'remove'; id: string }            // chỉ phần tử origin owner; phần tử AI thì dùng override hidden
  | { op: 'split'; id: string; at: number } // tách một phần tử thời gian tại `at` (giây output)
  | { op: 'toggleWords'; words: number[] }  // bật/tắt cắt từng từ (như PATCH hiện có)
  | { op: 'restore'; id: string; fromVersion: number };

// body: { baseVersion: number; ops: PlanOp[] }  → { plan, project }
// 409 nếu baseVersion khác bản hiện tại hoặc project.busy.
```

Gom bản nháp: nếu bản hiện tại có `author: 'owner'` và `planStatus` là `draft` thì sửa tại chỗ (tăng `rev`), không tạo phiên bản mới; ngược lại tạo phiên bản mới `author: 'owner'`.

### Template (`server/edit/templates/types.ts`)

```ts
export interface PropDef {
  type: 'text' | 'markup' | 'list' | 'number' | 'color' | 'asset';
  label: string;
  required?: boolean;
  maxWords?: number; maxLines?: number; maxItems?: number;
}

export interface ComponentDef {
  kind: 'beat' | 'scene' | 'graphic' | 'broll-frame';
  label: string;
  file: string;                         // sub-composition HyperFrames, đường dẫn tương đối trong thư mục mẫu
  runtime: 'gsap' | 'lottie' | 'three' | 'animejs' | 'css' | 'waapi' | 'typegpu';
  props: Record<string, PropDef>;
  duration: { min: number; max: number; default: number };
  animations?: string[];                // preset hiệu ứng vào được phép; mặc định tất cả
  safeZone?: { top: number; bottom: number };  // % khung dọc không được đặt chữ lớn
  useWhen?: string; avoidWhen?: string; // cho đạo diễn
}

export interface CaptionStyle {
  pos: number;                          // 0..1 từ trên xuống
  maxWidthPct: number; align: 'center' | 'left';
  font: { family: string; sizePct: number; weight: number; upper?: boolean };
  fill: string; stroke?: { color: string; width: number }; shadow?: string;
  box?: { color: string; padding: number; radius: number };
  highlight: { color: string; mode: 'color' | 'box' | 'pop' };
  maxWordsPerChunk: number;
}

export interface TemplateManifest {
  id: string; version: string; name: string; description: string;
  tags: string[]; tier: 'free' | 'pro'; aspects: VideoAspect[];
  poster?: string; preview?: string;
  styleId?: string;                     // VideoStyle nền (cutPace, musicMoods, sfxDensity)
  tokens: { fonts: { title: string; sub: string; caption: string }; colors: Record<string, string> };
  captions: CaptionStyle;
  components: Record<string, ComponentDef>;
  animations: { id: string; label: string; sound?: string }[];   // sound: id SFX khi sound.mode auto
  sounds: { density: 'none' | 'low' | 'medium' | 'high'; transition?: string; click?: string };
  rules: string;                        // tên file luật cho đạo diễn, thường 'rules.md'
  license?: { source: string; attribution?: string };
  legacy?: boolean;                     // mẫu bọc VideoStyle cũ, dùng overlays cũ
}

export interface TemplateSummary {
  id: string; name: string; description: string; tags: string[]; tier: 'free' | 'pro';
  installed: boolean; legacy: boolean; posterUrl?: string; previewUrl?: string;
  sample?: { kicker?: string; title: string; font: string; color: string; tone: string };  // để vẽ thẻ khi chưa có poster
}
```

Registry (`server/edit/templates/registry.ts`): `listTemplates(): TemplateSummary[]`, `getTemplate(id): TemplateManifest | null`, `templateDir(id)`, `templateForPrompt(id): string` (rules.md + danh sách component, props, preset; gọn, tiếng Việt), `componentHtml(id, componentId): string`.

### Cài đặt Dựng nhanh trên dự án

```ts
// VideoProject: thêm
quick?: {
  mode: 'ai' | 'manual';
  autoCut: boolean;
  cutLevel: 'nhe' | 'vua' | 'sat';      // gapMs gợi ý 800 / 400 / 250
  templateId: string;
  assets: { assetId: string; hint?: string }[];
  music: { mode: 'ai' | 'pick' | 'none'; assetId?: string; duck: boolean; snapToBeat: boolean; endOnFinal: boolean };
  stock: boolean;                       // cho phép tìm thêm cảnh trám
  note?: string;
  startedAt: string;
};
```

`POST /projects/:id/ai-edit` nhận `quick` (trừ `startedAt`), lưu vào dự án, tự duyệt plan cho riêng dự án này, rồi chạy chuỗi. 409 nếu chưa có video nguồn. Trả `{ project, job }`.

Dự án Dựng nhanh được tạo bằng `POST /projects` với `flow: 'quick'` (`VideoProject.flow?: 'quick'`) và upload ngay khi vào màn Thiết lập, nên ingest → transcribe → analyze chạy trong lúc chủ kênh thiết lập. Với dự án `flow: 'quick'` chưa có `quick`, runner không tự chạy `direct` sau analyze (bước `direct` ở trạng thái `waiting`, "Chờ bạn bấm AI edit"). `POST /ai-edit`: analyze đã xong thì chạy `direct` (hoặc plan auto khi `mode: 'manual'`) ngay; chưa xong thì chuỗi tự đi tiếp theo `quick`.

### Asset Hub (`server/edit/assets/types.ts`)

```ts
export type AssetSource = 'project' | 'mine' | 'pexels' | 'pexels-photo';

export interface AssetLicense { name: string; creator?: string; sourceUrl?: string; attributionRequired: boolean }

export interface AssetCandidate {
  ref: string;                 // assetId trong kho, hoặc 'pexels:video:<id>' / 'pexels:photo:<id>' khi chưa tải
  source: AssetSource;
  kind: 'video' | 'image' | 'bgm' | 'sfx';
  caption: string;             // mô tả tiếng Việt
  thumbUrl?: string; durationSec?: number; width?: number; height?: number;
  license: AssetLicense;
  score?: number;              // 1..5 do AI chấm theo câu đang nói
  reason?: string;
}

export interface AssetShortlist {
  projectAssets: { assetId: string; kind: 'video' | 'image'; hint?: string; caption?: string }[];
  library: AssetCandidate[];   // Kho của tôi hợp với lời chép
  music: AssetCandidate[];     // theo mood của mẫu; có bpm
  sfx: AssetCandidate[];
}

// server/edit/assets/shortlist.ts
export async function buildShortlist(projectId: string): Promise<AssetShortlist>;
export function renderShortlistForPrompt(s: AssetShortlist): string;
// server/edit/assets/resolve.ts: điền assetId cho các B-roll có `query` mà chưa có file
export async function resolveBrolls(projectId: string, plan: EditPlan): Promise<{ plan: EditPlan; notes: string[] }>;
```

VideoAsset (kho) thêm trường tuỳ chọn: `caption?: string; quality?: number; indexedAt?: string; bpm?: number; beats?: number[]; vocals?: boolean; genre?: string; projectId?: string`.

## Các đợt và việc

```
Đợt 1 (song song):  T1 plan-v2          T2 templates
Đợt 2 (song song):  T3 pipeline-ai-edit T4 composition-v2   T5 asset-hub   T6 web-quick-flow
Đợt 3 (song song):  T7 editor-v2-basic  T8 integration-docs
```

Trước đợt 2, điều phối viên gộp đợt 1 và đặt stub `assets/types.ts`, `assets/shortlist.ts`, `assets/resolve.ts` (trả shortlist rỗng, plan nguyên vẹn) để T3 gọi được trong khi T5 làm thật.

### T1 · plan-v2 (đợt 1)

- **Phạm vi:** `server/edit/types.ts`, `web/lib/video-edit/types.ts`, `server/edit/pipeline/plan.ts`, mới `server/edit/plan-ops.ts`, mới `server/edit/overrides.ts`, mới `server/edit/routes-plan-v2.ts` (+ một dòng đăng ký trong `routes.ts`), `server/edit/store.ts` (đọc/ghi overrides), test tương ứng.
- **Làm:** kiểu Plan v2, `quick` trên dự án, trường mới của VideoAsset; schema zod + validator theo luật trên (giữ tương thích plan cũ); `computeKeep`/dời `at` theo `anchorWord` áp cho beats/scenes/graphics/zooms; ops engine + `POST /projects/:id/plan/ops`; store overrides + `GET/PUT /projects/:id/overrides` (PUT nhận từng phần tử, merge) + tính `dropped`; hàm `preserveOwnerElements(prev, next)` để runner gọi khi AI nộp plan. Port ý tưởng và phần phù hợp của openfilm `src/overrides.mjs`, `studio/ui/src/lib/film-overrides.ts`, `studio/ui/src/lib/dropped-overrides.ts`, `studio/server/ops.mjs`, `editor/undo.ts` (MIT, ghi NOTICES).
- **Nghiệm thu:** test cho validator (plan cũ hợp lệ, plan v2 hợp lệ/không hợp lệ), ops (add/remove/split/toggleWords/restore, gom bản nháp, 409), overrides (merge, dropped), `preserveOwnerElements`; toàn bộ test module và typecheck qua.

### T2 · templates (đợt 1)

- **Phạm vi:** mới `modules/video/templates/**`, mới `server/edit/templates/{types,registry,routes}.ts` (+ một dòng đăng ký trong `routes.ts`), test.
- **Làm:** kiểu ở mục Template; registry đọc mẫu cài sẵn và mẫu trong `<data>/video-edit/templates`, kiểm tra manifest bằng zod, báo lỗi rõ khi manifest hỏng; bọc 21 `VIDEO_STYLES` thành mẫu `style:<id>` `legacy: true`; `GET /templates`, `GET /templates/:id`, `GET /templates/:id/files/:name` (chặn đường dẫn ra ngoài thư mục mẫu), `POST /templates/:id/install` (GĐ1: ghi danh sách đã cài vào settings, mẫu cài sẵn luôn installed). Mẫu `th-vang` đầy đủ: `template.json`, `rules.md`, block HyperFrames GSAP seek-safe cho `text-beat` (5 preset: typewriter, slide-short, slide-up, pop, fade; markup `*…*` và `|`), `scene-steps` (tiêu đề "BƯỚC n" + danh sách 2–5 mục hiện lần lượt, nền đen), `scene-before-after`, `broll-frame` (full / card / pip-circle), `logo-end`; kiểu phụ đề trắng viền tối, tô vàng từ khoá. Font Anton + Montserrat lấy qua thư viện font của module (`library/store.ts` `listFonts`, `pipeline/library-resolve.ts`). Không số ngẫu nhiên, không rAF/timer, không lặp vô hạn. Tham khảo ý tưởng: `awesome-hyperframes-prompt` (caption-styles, split-screen, knowledge-explainer), skill `hyperframes-core` và `hyperframes-animation` nếu có trên máy.
- **Nghiệm thu:** test registry (đủ 22 mẫu, manifest hỏng bị từ chối, đường dẫn file an toàn, `templateForPrompt` chứa rules và component); test mỗi block của `th-vang`: HTML hợp lệ, có `data-composition-id`, timeline GSAP tạm dừng, không chứa `Math.random`/`requestAnimationFrame`/`setInterval`. Nếu có `npx hyperframes` trên máy thì chạy lint/check cho block và ghi kết quả vào báo cáo.

### T3 · pipeline-ai-edit (đợt 2)

- **Phạm vi:** mới `server/edit/routes-quick.ts` (+ đăng ký), `pipeline/runner.ts`, `pipeline/analyze.ts`, `pipeline/normalize.ts`, `pipeline/transcribe.ts`, mới `pipeline/speech-probe.ts`, `agent/director.ts`, `agent/plan-schema.ts`, `skills/video-edit/**` (thêm tham chiếu plan v2, mẫu, tư liệu).
- **Làm:** `POST /projects/:id/ai-edit` theo hợp đồng; runner: tự duyệt plan khi `project.quick` có mặt (không đụng `autoApprovePlan` của hồ sơ), `mode manual` bỏ `direct` và tạo plan `author: 'auto'` (cắt theo analysis nếu `autoCut`, phụ đề theo mẫu, `templateId`), sau `direct` gọi `preserveOwnerElements` (T1) và `resolveBrolls` (stub/T5); `autoCut false` ép `cutWords = []`; `cutLevel` → `gapMs` gợi ý. Prompt đạo diễn khi có `quick`: `templateForPrompt` thay cho `promptNotes`, `renderShortlistForPrompt`, tư liệu kèm mô tả (ảnh nhỏ đính kèm qua `images`), ghi chú, phần tử chủ kênh đã sửa (chỉ đọc), luật cắt thô từng câu và chọn bản nói tốt nhất (ý tưởng từ OpenStoryline `prompts/tasks/speech_rough_cut`, video-use SKILL.md), yêu cầu trả plan v2 (beats/scenes theo component của mẫu, B-roll stock ghi `query`). Analyze: đánh dấu đoạn có tiếng mà không có từ (năng lượng âm thanh) là ứng viên từ đệm. Port `speech-probe.ts` và phần hữu ích của `whisper-mapper.ts` từ open-edit (Apache-2.0); HDR→SDR (`zscale` + `tonemap`) trong normalize theo video-use `render.py` (MIT), chỉ bật khi nguồn là HLG/PQ và ffmpeg có zimg (doctor báo khi thiếu).
- **Nghiệm thu:** test route (409 khi chưa có nguồn, lưu `quick`, chạy chuỗi bằng fake), runner (tự duyệt khi quick, manual tạo plan auto, autoCut false, owner elements được giữ), prompt (có rules mẫu, tư liệu + hint, shortlist, không có `promptNotes` khi có mẫu), speech-probe trên tín hiệu tổng hợp, normalize chọn bộ lọc tonemap khi metadata HDR.

### T4 · composition-v2 (đợt 2)

- **Phạm vi:** `pipeline/composition.ts` (có thể tách helper mới trong `pipeline/composition-v2/`), `pipeline/render.ts`, `pipeline/covers.ts` nếu cần, test.
- **Làm:** khi plan có `templateId` không legacy: nhúng block của mẫu cho beats/scenes/graphics và khung B-roll (sub-composition, truyền props), mỗi phần tử có `data-el-id`; áp `overrides.json` (vị trí/cỡ qua thuộc tính CSS `translate`/`scale` riêng, chữ, animIn, sound, thời gian, hidden) sau mỗi seek, theo openfilm `src/overrides.mjs` (MIT); phụ đề theo `CaptionStyle` của mẫu, chia cụm theo video-use `chunk_words` (2–3 từ, ngắt ở lặng 0,3s; MIT) và giới hạn `maxWordsPerChunk`; zoom theo plan; SFX tự động theo preset/`sounds` của mẫu; nhạc: giảm khi có giọng bằng tự động hoá âm lượng/voiceover carve của HyperFrames, `endOnFinal` canh nốt cuối trùng kết video, `snapToBeat` kéo `at` của beats/scenes vào nhịp gần nhất trong 0,5s khi bài có `beats`; kiểm tra font đã nạp (`document.fonts.check`) trước khi render. Plan legacy giữ đường cũ, đầu ra không đổi.
- **Nghiệm thu:** test composition: plan cũ cho HTML giống hệt trước; plan v2 có đủ `data-el-id`, block đúng component, override áp đúng, phần tử hidden không có, phụ đề chia cụm đúng, snapToBeat dời trong 0,5s; tất định (cùng đầu vào → cùng HTML). Có ffmpeg/hyperframes thì render thử một plan v2 ngắn và ghi kết quả.

### T5 · asset-hub (đợt 2)

- **Phạm vi:** `server/edit/assets/**` (thay stub), `server/edit/library/store.ts` (trường mới, ghi kết quả lập chỉ mục), mới `server/edit/assets/routes.ts` (+ đăng ký), test.
- **Làm:** providers `project`, `mine` (Kho của tôi), `pexels` (video), `pexels-photo` dùng `src/integrations/pexels/client.ts` và `bestVideoFile` có sẵn, lọc dọc 9:16 và 1–30s; mọi ứng viên kèm `license`. Lập chỉ mục: hàng đợi nhẹ mô tả file mới bằng `ctx.agents.runLean` + `images` (2–6 khung trích bằng ffmpeg), ra `caption` tiếng Việt + `quality` 0..1 (theo prompt mô tả clip của OpenStoryline); nhạc: đo `bpm` và `beats` (nhịp mạnh) từ PCM qua ffmpeg (theo OpenStoryline `select_bgm.py`, viết lại bằng TS), AI gắn mood/genre/vocals. `buildShortlist` (tư liệu dự án; kho theo khớp chữ giữa caption và lời chép; nhạc theo mood của mẫu và `music.mode`; SFX theo mẫu). `resolveBrolls`: với B-roll có `query` mà chưa có file, tìm theo thứ tự nguồn, AI chấm 1–5 theo câu đang nói (ảnh nhỏ), giữ ≥3, tránh hai cảnh giống nhau liền nhau, tải về kho (`addFile`) kèm license/attribution, điền `assetId`; không có cảnh đạt thì bỏ chỗ trám và ghi lý do. Routes: `GET /assets/search?q&kind&source`, `POST /assets/fetch`, `POST /assets/index` (lập chỉ mục lại một file). Pexels chưa có API key thì bỏ qua nguồn đó và ghi chú, không lỗi.
- **Nghiệm thu:** test với fake Pexels và fake runLean: thứ tự nguồn, lọc ≥3, tránh trùng, license đi kèm, tải về kho; beats từ tín hiệu tổng hợp (ví dụ nhịp 120 BPM); shortlist và chuỗi prompt.

### T6 · web-quick-flow (đợt 2)

- **Phạm vi:** `web/pages/VideoStudio.tsx` (thêm tab "Dựng nhanh"), `web/lib/video-edit/studio-tabs.ts`, mới `web/components/video-studio/quick/**`, mới `web/lib/video-edit/quick-api.ts`, mới `web/styles/video-quick.css`, test web.
- **Làm:** ba màn theo mockup `Main`, `Setup`, `Progress`. Trang đầu: danh sách dự án của hồ sơ kênh đang chọn, kéo thả video (tạo dự án qua `POST /projects` rồi upload như `TemplateStart.tsx`), ô ghi chú, thư viện mẫu từ `GET /templates` (lọc theo tag, tìm, thẻ có poster hoặc vẽ từ `sample`, nhãn FREE/PRO/Đã cài). Thiết lập: 6 bước như mockup (video, tự cắt + mức, mẫu, tư liệu nhiều file + mô tả từng file, nhạc AI chọn/chọn bài/không nhạc + giảm khi nói, tìm thêm cảnh trám, ghi chú), cột "AI sẽ làm", nút "Bỏ qua — tự chỉnh tay" (`mode manual`) và "AI edit" (`POST /ai-edit`). Tư liệu tải lên qua `uploadLibraryAsset` có sẵn. Đang dựng: các bước và dòng bằng chứng từ `project.steps` và sự kiện `video:job`/`video:step` có sẵn; nút Dừng (`/abort`), "Mở editor" (tạm mở màn chỉnh sửa có sẵn cho tới khi T7 xong). Chọn bài nhạc: danh sách bgm từ `GET /assets?kind=bgm` có sẵn.
- **Nghiệm thu:** test web cho thẻ mẫu/lọc, form thiết lập tạo đúng body `ai-edit`, màn đang dựng hiển thị bước; typecheck web qua; giao diện khớp mockup ở 1440px và không tràn ngang ở 390px.

### T7 · editor-v2-basic (đợt 3)

- **Phạm vi:** mới `web/components/video-studio/editor2/**`, mới `web/lib/video-edit/editor2.ts`, `web/styles/video-quick.css` (thêm), chuyển hướng "Mở editor" của T6 sang editor mới cho dự án có `quick`.
- **Làm:** theo mockup `Editor`: thanh trên (Thư viện, Nhờ AI sửa, hoàn tác/làm lại, Dựng nháp ẩn tới GĐ2, Xuất video), thanh công cụ trái, inspector sinh form từ `ComponentDef.props` (Chữ: nhãn nhỏ, tiêu đề markup kèm đếm từ/dòng, chữ phụ, hiệu ứng vào, âm thanh + Nghe thử, âm lượng, cỡ), preview `PreviewPlayer` có sẵn, danh sách lớp tại thời điểm hiện tại, timeline nhiều track (Chữ, Phụ đề, Minh hoạ, Cảnh trám, Đồ hoạ, Zoom, Nhạc, Tiếng động, Video, Góp ý) bấm để chọn phần tử và tua. Mọi chỉnh trong inspector ghi `PUT /overrides` (debounce 400ms) rồi tải lại preview; "Trả về như AI dựng" xoá override; dải báo phần tử bị AI bỏ kèm nút khôi phục (`op restore`); "Nhờ AI sửa" mở ô nhập gắn ngữ cảnh phần tử, gửi qua luồng góp ý có sẵn; Xuất video qua `approveAndExport` có sẵn. Bảng Thư viện cơ bản: đổi cảnh trám bằng `GET /assets/search` (đề xuất đã chấm), chọn nhạc.
- **Nghiệm thu:** test web cho inspector (markup → đếm từ, ghi override), timeline chọn phần tử, dải phần tử bị bỏ; typecheck qua.

### T8 · integration-docs (đợt 3)

- **Phạm vi:** test tích hợp mới `server/edit/quick.integration.test.ts`, `README.md` của module, `skills/video-edit/references/*`, `THIRD_PARTY_NOTICES.md`, `server/edit/doctor.ts`.
- **Làm:** test chạy cả chuỗi `ai-edit` bằng fake tools + fake agent trả plan v2 (beats, scenes, B-roll có hint và có query), kiểm tra plan sau resolve, overrides giữ qua một lượt revise, composition chứa đủ phần tử; cập nhật README (tab Dựng nhanh, mẫu, kho, giấy phép), tham chiếu skill, NOTICES gộp đủ mục, doctor kiểm tra zimg/tonemap và Pexels key.
- **Nghiệm thu:** toàn bộ test module + typecheck qua; README và NOTICES đầy đủ.

## Điều phối viên tự làm

- Gộp từng đợt vào `feat/video-dung-nhanh`, giải xung đột (thường chỉ ở dòng đăng ký route trong `routes.ts`), chạy test + typecheck sau mỗi lần gộp.
- Đặt stub Asset Hub trước đợt 2.
- Sau đợt 3: chạy thật với video mẫu 28 giây trên máy (app chạy local), ghi kết quả và lỗi còn lại vào báo cáo cho chủ dự án.
