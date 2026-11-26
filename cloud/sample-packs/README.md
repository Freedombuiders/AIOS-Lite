# Gói mẫu

Mỗi thư mục ở đây là một gói dữ liệu ở dạng nguồn. Lệnh `build` biến nó thành file zip có `pack.json` đầy đủ.

```
<gói>/
  pack.json        thông tin gói, chưa có danh sách "files" (lệnh build tự điền)
  notes/…          ghi chú markdown, đặt đúng đường dẫn trong brain (bai-hoc/, cong-thuc/…)
  assets/…         ảnh minh hoạ, mỗi file tối đa 512 KB
```

Luật mà cloud kiểm khi `finalize` (xem `src/packs/zip-check.ts`):

- Zip tối đa 20 MB, tối đa 500 file.
- Mọi file nằm dưới `notes/` hoặc `assets/`; không có `..`, không bắt đầu bằng `/`.
- Mỗi file khai trong `pack.json` với SHA-256 đúng; không có file nào thừa hay thiếu.
- Mỗi ghi chú có khối YAML đầu file với `loai`, khớp với `loai` trong `pack.json`, và thuộc danh sách cho phép của module:

  | module | loai được phép |
  |---|---|
  | `brain` | `ho-so`, `giong-noi`, `san-pham`, `chinh-sach` |
  | `learn` | `bai-hoc`, `cong-thuc` |
  | `dream` | `cong-thuc`, `kenh-dream` |
  | `crm` | `mau-khach-hang` |

  Gói không bao giờ được chứa `khach-hang`, `bai-dang` hay `video-dream`: đó là dữ liệu của một shop, không phải kiến thức chung.

- Bài học vào ở `trang_thai: gia-thuyet`, công thức ở `trang_thai: chua-thu`, để bot kiểm lại trên kênh của chính shop (giả định G7).

## Chữ ký

Người phát hành ký bằng Ed25519 trên máy mình. Nội dung được ký là chuỗi UTF-8:

```
agenticos-pack-v1\n<id>\n<version>\n<sha256 của file zip, hex chữ thường>
```

Gắn `id` và `version` vào nội dung ký để không ai lấy chữ ký của gói này đem gắn cho gói khác hay bản khác. App trên máy kiểm lại đúng chuỗi này bằng khoá công khai gắn sẵn (T22).

## Thử

```sh
npm run pack -- build sample-packs/tra-va-qua-tang-co-ban --out /tmp/tra.zip
```
