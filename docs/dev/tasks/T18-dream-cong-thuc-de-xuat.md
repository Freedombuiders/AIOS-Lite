# T18 · Dream 100 phần 3: công thức, đề xuất hằng ngày, đối chiếu

> Nhánh Marketing · 3 ngày · Phụ thuộc: T15, T17 · Kế hoạch mục 5.7.6 đến 5.7.8

## Mục tiêu

Khép vòng Dream 100: video nổi bật thành công thức, công thức thành đề xuất mỗi sáng, bài đăng xong được so với công thức đã sinh ra nó.

## Bản vẽ tham chiếu

`Formulas.dc.html`, `DailyIdeas.dc.html`, `BrainMap.dc.html`.

## File đụng tới

`modules/dream/server/formulas.ts`, `ideas.ts`, `compare.ts`, `migrations/002_ideas.sql`, `web/` (hai trang); `modules/marketing/server/core/content.ts` (nhận `meta`); `modules/learn/server/post-notes.ts` (chép `meta` sang ghi chú, nếu T14 chưa làm).

## Mắt xích phải giữ

```
đề xuất  ──tạo──►  fb_content.meta { cong_thuc, hoc_tu }  ──đăng──►  ghi chú bài { cong_thuc, hoc_tu }
                                                                          │ mốc 24 giờ, 7 ngày
ghi chú công thức { da_lam, ket_qua, trang_thai }  ◄──tính lại──  so_voi_ky_vong
```

Đứt ở bất kỳ mũi tên nào thì không so được. Viết một test đi hết cả chuỗi trước khi viết từng phần.

## Các bước

**Công thức**

- [ ] Sau khi một video được mổ xẻ (T17): tìm công thức có cùng `mo_dau`, cùng `cau_truc`, và `do_dai` không quá `do_dai_toi_da`. Có thì ghi `cong_thuc` vào ghi chú video và tăng `bang_chung`.
- [ ] Không có: đếm video chưa thuộc công thức nào có cùng bộ nhãn trong 30 ngày. Từ 3 video thì nêu mục cần chú ý "rút thành công thức", kèm ba video đó.
- [ ] Chủ bấm duyệt: tạo `cong-thuc/<slug>.md` với `ky_vong: 1.5`, `trang_thai: chua-thu`, `da_lam: 0`. Tên do chủ đặt hoặc sửa từ gợi ý.
- [ ] Không có `ModuleAction` nào cho agent tạo hay sửa công thức. Quyền ghi `cong-thuc/**` không cấp cho agent nào trong gói đội mặc định.

**Đề xuất hằng ngày**

- [ ] Chạy sau lượt quét sáng (T16). Bảng `dream_ideas(day, slot, formula_path, source_video_path, status, content_id, PRIMARY KEY(day, slot))`.
- [ ] Code chọn: 2 công thức `hop` hoặc `co-ve-hop`, 1 công thức `chua-thu`. Loại `tru_cot` đã có bài trong 7 ngày. Ưu tiên công thức vừa có video nổi bật hôm nay. Không đủ công thức thì ít đề xuất hơn, không bịa thêm.
- [ ] Với mỗi lựa chọn, một lượt `lean` nhận: ghi chú công thức, ghi chú video nguồn, kết quả tìm brain trong `san-pham/` và `giong-noi.md`. Đòi `{ tieu_de, cau_mo_dau, viec_can_lam, nen_tang }`.
- [ ] Ghi `noi-dung/de-xuat/<ngày>.md` và nêu một mục cần chú ý.
- [ ] "Giao Bot Nội dung viết": tạo `fb_content` trạng thái `idea` với `meta.cong_thuc`, `meta.hoc_tu`, `meta.de_xuat`. Kiểm `core/content.ts` có giữ `meta` qua các lần chuyển trạng thái tới `published` không; nếu không thì sửa cho giữ.
- [ ] "Bỏ, không hợp" hỏi một lý do ngắn, lưu lại. Lý do bị bỏ ba lần cho cùng một công thức thì hạ ưu tiên công thức đó.

**Đối chiếu**

- [ ] `compare.ts` nghe `learn` báo một ghi chú `bai-dang` có `cong_thuc` vừa nhận mốc `24h` hoặc `7d`.
- [ ] `ky_vong_er`: trung vị ER các bài của mình theo công thức đó nếu đã có từ 3 bài; chưa thì `cong_thuc.ky_vong` nhân ER trung vị của kênh.
- [ ] Ghi `so_voi_ky_vong` vào ghi chú bài. Tính lại `da_lam`, `ket_qua`, `trang_thai` của công thức theo ngưỡng ở mục 5.7.8.
- [ ] Một lượt `lean` viết tối đa hai câu về chỗ khác biệt giữa bài của mình và các video gốc (so nhịp cắt, độ dài, kiểu mở đầu từ số đo). Ghi vào một khối máy quản lý trong thân ghi chú công thức.
- [ ] Công thức chuyển sang `hop` thì gọi `learn.propose` để tạo một bài học `gia-thuyet` trỏ tới các bài làm bằng chứng.

## Test

- Test cả chuỗi: đề xuất, giao viết, đăng (dùng `marketing` với Composio giả), mốc 24 giờ, rồi kiểm ghi chú công thức có `da_lam: 1` và `ket_qua` đúng.
- Chỉ có 1 công thức: ra 1 đề xuất.
- Agent trả thêm khoá lạ: bị từ chối, slot đó trống.
- Ghi vào `cong-thuc/` với `actor` là id agent bị dịch vụ ghi chú từ chối.
- Ngưỡng trạng thái: 2 bài với `ket_qua` 1,3 ra `co-ve-hop`; 3 bài ra `hop`; 3 bài với 0,8 ra `chua-hop`.

## Xong khi

- `npx vitest run modules/dream modules/learn modules/marketing` qua.
- Chạy một ngày thật với 3 kênh: sáng có ghi chú đề xuất.

## Ghi chú

"Bot Đối chiếu" trong bản vẽ là việc `compare.ts` này cộng một lượt agent viết lời. Nó không phải một agent tự do có quyền ghi.
