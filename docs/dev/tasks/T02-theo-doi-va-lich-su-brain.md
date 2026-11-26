# T02 · Theo dõi thay đổi, lịch sử git, liên kết

> Nhánh Nền · 2 ngày · Phụ thuộc: T01 · Kế hoạch mục 5.0

## Mục tiêu

Sửa một ghi chú ở đâu (trong app, trong Obsidian, do bot ghi) thì cả hệ thống biết ngay; mỗi lần máy ghi đều hoàn tác được; module dùng được dịch vụ ghi chú.

## Làm và không làm

- Làm: theo dõi file, sự kiện `brain:changed`, commit git, bảng `brain_links`, mở rộng `ctx.brain`.
- Không làm: giao diện đồ thị (T11); đẩy brain lên GitHub.

## File đụng tới

| File | Loại |
|---|---|
| `src/shared/brain-watch.ts` | MỚI |
| `src/shared/brain-git.ts` | MỚI |
| `src/core/migrations/00X_brain_links.ts` | MỚI |
| `src/shared/brain.ts` | SỬA: trích liên kết lúc lập chỉ mục |
| `src/shared/notes.ts` | SỬA: gọi commit sau khi ghi; thêm `backlinks` |
| `src/modules/sdk.ts:78-167`, `src/modules/context.ts` | SỬA: `ctx.brain` có thêm `notes` |
| `src/main.ts:133-143` | SỬA: bật theo dõi |
| `package.json` | SỬA: thêm `chokidar` |

## Các bước

- [ ] `brain-watch.ts`: theo dõi mọi thư mục trong `config/brain.yaml`. Bỏ qua `.git`, `.obsidian`, `.trash`, `node_modules` (cùng danh sách với bộ lập chỉ mục). Gộp sự kiện trong 500 ms cho mỗi thư mục rồi gọi `brain.reindex({ folderId })`.
- [ ] Sau khi lập chỉ mục lại, phát `{ type: 'custom', name: 'brain:changed', payload: { folderId, paths } }` qua bus (`src/core/events.ts:15-26`).
- [ ] Khi `brain.yaml` đổi (thêm, bớt thư mục), dựng lại bộ theo dõi.
- [ ] Migration lõi: `brain_links(folder_id, src_path, dst_slug, PRIMARY KEY(folder_id, src_path, dst_slug))` và chỉ mục theo `dst_slug`.
- [ ] Trong `brain.ts`, lúc lập chỉ mục một file: trích mọi `[[slug]]` và `[[slug|nhãn]]` ở cả phần thân lẫn thuộc tính; xoá liên kết cũ của file rồi ghi mới. File bị xoá thì xoá liên kết của nó.
- [ ] `brain-git.ts`: `isRepo(dir)`, `commit(dir, paths, message, author)`. Gọi `git` bằng `execFile`, không qua shell. Thư mục không phải kho git thì trả về, ghi một dòng log mức `info`. Không tự `git init`.
- [ ] `NotesService` gọi `commit` sau mỗi lần ghi thành công. Tác giả commit là `actor`. Ghi do `owner` qua `PUT /api/brain/file` cũng commit.
- [ ] Thêm `revert(ref, commitHash)` vào `NotesService`: khôi phục một file về trước commit đó, bằng một commit mới.
- [ ] `ctx.brain.notes` cho module: bọc `NotesService`, tự điền `actor = 'module:<id>'` khi module không truyền agent.

## Hợp đồng

```ts
// thêm vào NotesService
backlinks(ref: NoteRef): NoteRef[];
history(ref: NoteRef, limit?: number): { hash: string; at: string; author: string; message: string }[];
revert(ref: NoteRef, hash: string, opts: WriteOpts): Note;

// src/modules/sdk.ts, trong ModuleContext
brain: {
  search(query: string, opts?: { folders?: string[]; limit?: number }): BrainHit[];
  notes: NotesService;
};
```

## Test

- `brain-watch.test.ts`: tạo, sửa, xoá file trong thư mục tạm; kiểm sự kiện phát đúng một lần cho một loạt thay đổi dồn dập.
- `brain-git.test.ts`: thư mục là kho git thì có commit; không phải thì không lỗi; lời nhắn chứa ký tự đặc biệt không làm hỏng lệnh.
- `brain.test.ts`: liên kết được trích đúng; đổi nội dung thì liên kết cũ biến mất.

## Xong khi

- Sửa một file bằng trình soạn thảo ngoài, `GET /api/brain/search` thấy nội dung mới trong 2 giây.
- Ghi qua `NotesService` trong kho git tạo đúng một commit; `revert` đưa file về như cũ.
- Module `_template` gọi được `ctx.brain.notes.create`.

## Ghi chú

- Hai lần ghi liên tiếp rất nhanh vào cùng một kho git có thể đụng khoá `index.lock`. Xếp hàng các lệnh git theo từng thư mục.
- Bộ theo dõi sẽ thấy cả thay đổi do chính `NotesService` ghi. `reindex` theo `mtime` nên chạy lại không hại, nhưng đừng commit lần hai.
