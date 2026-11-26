# crm — Khách hàng thành ghi chú

Mỗi khách trong module **Chăm sóc khách hàng** (`care`) có một ghi chú `khach-hang/<ten-khach>.md` trong thư mục Second Brain của công ty. Máy tự tạo và cập nhật ghi chú từ cơ sở dữ liệu của `care`. Bạn mở ghi chú trong Obsidian, ghi thêm gì tuỳ ý.

**Đồng bộ một chiều.** Cơ sở dữ liệu là bản gốc. Máy chỉ ghi từ cơ sở dữ liệu ra ghi chú, không đọc gì từ ghi chú ngược vào. Sửa giai đoạn, số điện thoại, nhãn, nhu cầu hay việc cần làm thì sửa trong app (Chăm sóc khách hàng › Khách hàng).

## Dùng thế nào

1. Bật `care` trước, rồi **Add** module `crm`.
2. Trong cài đặt module CRM, điền **Thư mục Second Brain cho ghi chú khách** (`folderId`): mã thư mục trong `config/brain.yaml`, ví dụ `cong-ty-a`. Chưa điền thì máy không xuất gì; trạng thái (`GET /api/m/crm/status`) báo `chua-cau-hinh`.
3. Lần chạy đầu, máy tạo ghi chú cho mọi khách đang có, theo lô 50 khách, mỗi lô một commit git, chạy nền nên không làm chậm lúc khởi động.
4. Sau đó, cứ vài giây máy đọc dòng thay đổi của `care` và cập nhật ghi chú của đúng những khách vừa đổi.

## Ba màn hình

Menu **Khách hàng** (Chăm sóc khách hàng) mở các màn này khi module `crm` bật; `/m/care/customers` chuyển sang `/m/crm/stages`. Khi `crm` tắt, danh sách cũ của `care` vẫn hiện.

- **Giai đoạn** (`/m/crm/stages`): bảng cột theo giai đoạn của `care`. Kéo thẻ sang cột khác (hoặc chọn ở ô trên thẻ, dùng được trên điện thoại) để đổi giai đoạn; màn gọi đúng đường sửa hồ sơ của `care` (`PUT /api/m/care/conversations/:id/customer-care`, cuộc trò chuyện chính của khách đó), ghi chú đổi theo sau vài giây. Lỗi thì thẻ về chỗ cũ và có thông báo. Phía trên có mục "Cần chăm hôm nay" (việc quá hạn hoặc đến hạn hôm nay).
- **Tất cả khách** (`/m/crm/all`): bảng các khoá do máy quản (`ten · tệp`, `giai_doan`, `the`, `sdt`, `viec_tiep · han`, `cap_nhat`), lọc theo giai đoạn, thẻ, hạn, tìm chữ; bộ lọc đặt tên lưu trong trình duyệt này (localStorage), không đồng bộ giữa các máy. Chưa có cột Zalo vì `care` chưa có dữ liệu kết bạn.
- **Hồ sơ** (`/m/crm/customer/:id`): thuộc tính, nút "File gốc" hiện đúng markdown của ghi chú (đọc bằng `GET /api/brain/file`), khách cần gì, nhật ký, việc chưa xong (Xong, Dời hạn), "Mở cuộc chat" (sang Hộp thư), "Mở bằng Obsidian" (`obsidian://open?path=` dựng từ đường dẫn tuyệt đối của thư mục + đường dẫn ghi chú).

Chưa chọn thư mục Second Brain: cả ba màn vẫn chạy từ cơ sở dữ liệu, có thanh báo trỏ tới Module CRM; "File gốc" và "Mở bằng Obsidian" tắt vì chưa có file.

## Trong một ghi chú, phần nào của ai

```markdown
---
loai: khach-hang          ┐
id: 3f2c…                 │
ten: Chị Lan              │
sdt: "0901234567"         │ máy ghi (khoá do máy quản)
giai_doan: dang-tu-van    │
the: [hoi-si, o-long-sen] │
viec_tiep: Gửi báo giá    │
han: 2026-11-28           │
cap_nhat: 2026-11-26T09:44:00+07:00 ┘
nguon: Bài đăng "Trà sen Tây Hồ"    ← của bạn: máy không đụng
---
# Chị Lan                           ← của bạn

<!-- aios:begin khach-can-gi -->
## Khách cần gì                     ← máy ghi, từ hồ sơ nhu cầu trong care
<!-- aios:end khach-can-gi -->

<!-- aios:begin nhat-ky -->
## Nhật ký                          ← máy ghi: 20 thay đổi gần nhất, mỗi dòng một tóm tắt
<!-- aios:end nhat-ky -->

Mọi dòng bạn viết ngoài hai khối trên ← của bạn, giữ nguyên từng byte
```

- **Khoá do máy quản:** `loai`, `id`, `ten`, `sdt`, `giai_doan`, `the`, `viec_tiep`, `han`, `cap_nhat`. Ở lần xuất kế tiếp của khách đó, máy ghi đè các khoá này theo cơ sở dữ liệu. **Nếu bạn sửa tay một khoá máy quản (ví dụ đổi `giai_doan` trong Obsidian), lần cập nhật sau của khách đó sẽ ghi đè lại, và máy không báo gì.** Muốn đổi thật thì đổi trong app.
- **Khoá của bạn:** mọi khoá khác (`nguon`, `gia_tri`, `hang`, khoá tự đặt…) được giữ nguyên giá trị, thứ tự và chú thích `# …`. Bộ ghi YAML dùng chung có thể chuẩn hoá khoảng trắng bên trong khối thuộc tính (ví dụ `[a]` thành `[ a ]`); phần thân ghi chú thì không bị đụng một byte nào.
- **Khoá không có dữ liệu thì không ghi.** `care` chưa có `nguon`, `gia_tri`, `da_mua`, `hang`, trạng thái kết bạn Zalo, nên máy không ghi các khoá đó (không để trống, không bịa). `sdt`, `the`, `viec_tiep`, `han` vắng mặt khi khách chưa có số, chưa có nhãn, hoặc không còn việc nào chưa xong.
- `viec_tiep` và `han`: việc chưa xong có hạn sớm nhất trong Việc chăm sóc. `the`: nhãn của khách, tách theo dấu phẩy, viết dạng slug (`hỏi sỉ` → `hoi-si`). `cap_nhat`: lúc khách thay đổi gần nhất (không phải lúc máy ghi file).
- `giai_doan`: `moi` (new), `dang-tu-van` (consulting), `da-bao-gia` (quoted), `dat-coc` (deposit), `da-chot` (won), `mat` (lost).
- **Nhật ký** chỉ liệt kê thay đổi của khách trong `care` (tạo khách, đổi giai đoạn, sửa thông tin, nhu cầu, việc cần làm). Không chép nội dung tin nhắn nào vào ghi chú.

## Tên file

Tên khách bỏ dấu, viết thường, nối bằng gạch ngang: `Chị Lan` → `khach-hang/chi-lan.md`. Trùng tên thì thêm `-2`, `-3`. **Đổi tên khách không đổi tên file** (chỉ `ten` trong thuộc tính đổi). Bạn được đổi tên hoặc chuyển file sang thư mục con của `khach-hang/`: máy tìm lại ghi chú theo `id` và cập nhật đúng file đó.

## Khi bạn xoá file, khi khách bị xoá

- **Bạn xoá file ghi chú:** khách vẫn còn trong `care`, máy không xoá khách. Ở lần khách đó thay đổi tiếp theo, máy tạo lại ghi chú (cùng đường dẫn nếu còn trống) và nêu một mục "cần chú ý". Muốn bỏ hẳn khách thì xoá trong app.
- **Khách bị xoá trong `care`:** máy xoá file ghi chú (qua dịch vụ ghi chú, có commit git) và dòng chỉ mục. Phần bạn tự viết trong ghi chú đó cũng mất khỏi thư mục (vẫn còn trong lịch sử git). Hiện `care` chưa có thao tác xoá khách; khi có, ghi chú tự đi theo.
- Ghi chú có YAML hỏng hoặc khối đánh dấu `aios:begin/end` bị sửa hỏng: máy bỏ qua ghi chú đó, nêu mục cần chú ý, và thử lại ở lần khách đó thay đổi tiếp theo. Các khách khác vẫn được cập nhật.

## Dữ liệu cá nhân ở dạng chữ thường (quyết định có chủ đích)

Trong cơ sở dữ liệu, `care` mã hoá tên, số điện thoại, email, nhãn của khách. **Ghi chú khách thì không mã hoá:** tên, số điện thoại, nhãn, nhu cầu và tên việc cần làm nằm ở dạng chữ thường trong file `.md`, và trong mọi commit git của thư mục Second Brain. Đây là quyết định sản phẩm: ghi chú phải đọc được trong Obsidian và tìm được bằng công cụ tìm kiếm của brain.

Hệ quả bạn cần biết:

- Ai đọc được thư mục Second Brain (hoặc bản sao, bản sao lưu, kho git đẩy lên máy chủ) là đọc được thông tin khách.
- **Xoá một khách xoá file ghi chú, nhưng không xoá các commit git cũ.** Thông tin của khách vẫn còn trong lịch sử git cho đến khi bạn tự viết lại lịch sử (ví dụ `git filter-repo`) và xoá mọi bản sao của kho.
- Agent chỉ đọc được ghi chú khách khi được cấp quyền đọc `khach-hang/**` của thư mục đó (`access.brain`).

## Cho lập trình viên

- Bảng: `crm_note_index` (khách ↔ ghi chú: `folder_id`, `rel_path` duy nhất trong từng thư mục, `content_hash` của phần máy quản đã ghi), `crm_sync_state` (con trỏ trong dòng thay đổi của `care` và tiến độ lần xuất đầu, theo từng thư mục).
- Nguồn dữ liệu: `ctx.modules.get('care').customers` (`get`, `list` có con trỏ, `changesSince`, `latestCursor`, `history`). Dòng thay đổi `care_customer_changes` do trigger SQLite ghi trong cùng giao dịch với mỗi lần ghi khách, hồ sơ, việc; không có dòng cho lần ghi không đổi gì. Không dùng `ctx.events` (module không nghe chéo được, và sự kiện trong bộ nhớ mất khi khởi động lại).
- Ghi file chỉ qua `ctx.brain.notes` (`create`, `patch`, `setBlock`, `remove`, `batch`). Mỗi lô là một `notes.batch` → một commit.
- Chạy hai lần không ghi lần hai: `patch`/`setBlock` không ghi khi nội dung không đổi. Sập giữa lúc ghi file và lúc lưu con trỏ: lần chạy sau áp lại cùng thay đổi; khách chưa có dòng chỉ mục được tìm theo `id` trong thư mục trước khi tạo file mới, nên không sinh ghi chú thứ hai.
- Đổi thư mục trong cài đặt: thư mục mới chạy lại lần xuất đầu của riêng nó; file trong thư mục cũ để nguyên.
- API cho web (chỉ đọc): `GET /api/m/crm/status`, `GET /api/m/crm/customers?after=&limit=` (khách, đường dẫn ghi chú, trạng thái `da-xuat` | `cho-xuat` | `chua-xuat`).
- API cho web (chỉ đọc), thêm: `GET /api/m/crm/customers/:id` (hồ sơ: nhu cầu, việc chưa xong, nhật ký ngắn).
- Chưa làm (để task sau): nhập ngược từ ghi chú vào cơ sở dữ liệu, xếp hạng, đơn hàng, chân dung "khách tốt nhất".
