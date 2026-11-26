# T01 · Ghi chú có thuộc tính

> Nhánh Nền · 2 ngày · Phụ thuộc: không · Kế hoạch mục 5.0

## Mục tiêu

Có một chỗ duy nhất để đọc và ghi ghi chú markdown có khối YAML ở đầu, kiểm kiểu theo trường `loai`, và có API ghi file cho giao diện.

## Làm và không làm

- Làm: đọc, ghi thuộc tính; kiểm lược đồ; kiểm quyền ghi theo agent; `PUT /api/brain/file`.
- Không làm: theo dõi thay đổi file, commit git, bảng liên kết (T02).

## File đụng tới

| File | Loại |
|---|---|
| `src/shared/frontmatter.ts` | MỚI (tách `parseFrontmatter` từ `src/teams/package.ts:37-42`) |
| `src/shared/note-schemas.ts` | MỚI |
| `src/shared/notes.ts` | MỚI |
| `src/teams/package.ts`, `src/shared/skills.ts:15` | SỬA: dùng hàm chung |
| `src/api/routes/brain.ts` | SỬA: thêm `PUT /api/brain/file` cạnh `GET` ở dòng 53 |
| `src/main.ts` | SỬA: dựng `NotesService`, đưa vào `deps` |

## Các bước

- [ ] Chuyển `parseFrontmatter` sang `frontmatter.ts`. Hai nơi cũ import lại. Test cũ của team và skill phải qua không sửa.
- [ ] Viết `writeFrontmatter(text, patch)`: giữ thứ tự khoá đang có, khoá mới thêm cuối, không đụng phần thân, giữ nguyên kiểu xuống dòng của file.
- [ ] Viết lược đồ zod cho từng `loai`: `khach-hang`, `bai-dang`, `cong-thuc`, `bai-hoc`, `kenh-dream`, `video-dream`, `tong-ket`, `de-xuat`. Lấy đúng tên khoá ở mục 4.2 của kế hoạch. Khoá lạ được giữ nguyên (không `strict`), để người dùng tự thêm thuộc tính trong Obsidian.
- [ ] Viết `NotesService` theo hợp đồng dưới.
- [ ] `actor` là id agent thì kiểm quyền ghi: lấy `access.brain` của agent, dùng `pathAllowed` (`src/access/policy.ts:99-107`). Hiện hàm này chưa có nơi nào gọi.
- [ ] Chặn đường dẫn thoát khỏi thư mục: chuẩn hoá rồi kiểm tiền tố; từ chối `..`, đường dẫn tuyệt đối, symlink.
- [ ] `PUT /api/brain/file`: thân `{ folder, path, content, expectMtimeMs? }`. Trả `{ mtimeMs }`. Lệch `mtime` trả 409. Chỉ nhận `.md`, tối đa 1 MB (cùng trần với bộ lập chỉ mục).

## Hợp đồng

```ts
// src/shared/frontmatter.ts
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string; has: boolean };
export function writeFrontmatter(text: string, patch: Record<string, unknown>): string;

// src/shared/notes.ts
export interface NoteRef { folderId: string; relPath: string }
export interface Note<T = Record<string, unknown>> extends NoteRef { data: T; body: string; mtimeMs: number }
export class NoteConflictError extends Error {}
export class NoteSchemaError extends Error { issues: string[] }
export class NoteAccessError extends Error {}

export interface WriteOpts { actor: 'owner' | 'system' | string; message: string; expectMtimeMs?: number }
export interface NotesService {
  read<T>(ref: NoteRef): Note<T> | undefined;
  patch(ref: NoteRef, patch: Record<string, unknown>, opts: WriteOpts): Note;
  create(ref: NoteRef, data: Record<string, unknown>, body: string, opts: WriteOpts): Note;
  list<T>(folderId: string, dir: string, filter?: { loai?: string }): Note<T>[];
}
```

`patch` trên ghi chú có `loai` thì kiểm kết quả sau khi gộp bằng lược đồ của `loai` đó. Sai thì ném `NoteSchemaError`, không ghi gì.

## Test

- `src/shared/frontmatter.test.ts`: file không có khối đầu; khối đầu có chú thích; giá trị là mảng, chuỗi có dấu hai chấm, chuỗi tiếng Việt có dấu; ghi rồi đọc lại ra đúng dữ liệu; phần thân không đổi một byte.
- `src/shared/notes.test.ts` (dùng `tmpDir`, `sampleBrain` trong `src/shared/test-kit.ts`): `expectMtimeMs` lệch; lược đồ sai; agent không có quyền ghi; đường dẫn `../x.md`.
- `src/api/routes/brain.test.ts`: `PUT` thành công, 409, 400 với file không phải `.md`.

## Xong khi

- Ba file test trên xanh; `npm run typecheck` qua.
- Trình sửa ghi chú trên web (`BrainNoteEditor.tsx:72`) lưu được. Trước task này nó gọi một đường chưa tồn tại.

## Ghi chú

Thư viện `yaml` đã có trong `package.json`. Không thêm `gray-matter`.
