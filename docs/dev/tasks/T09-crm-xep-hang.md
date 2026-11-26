# T09 · Module `crm` 2: đơn hàng, xếp hạng, chân dung, bốn màn

> Nhánh Chăm khách · 3 ngày · Phụ thuộc: T08, T10 · Kế hoạch mục 5.3.4, 5.3.5

## Mục tiêu

Biết 20% khách nào đáng giữ nhất, họ giống nhau ở điểm nào, và khách mới nào giống họ.

## Bản vẽ tham chiếu

`CRM.dc.html`, `CustomerList.dc.html`, `Customer.dc.html`, `CustomerTop.dc.html`.

## File đụng tới

`modules/crm/migrations/002_orders_scores.sql`, `server/orders.ts`, `server/score.ts`, `server/portrait.ts`, `server/match.ts`, `web/` (bốn trang).

## Các bước

**Đơn hàng**

- [ ] Bảng `crm_orders`, `crm_scores` (mục 5.3.2 của kế hoạch). Hiện không có dữ liệu đơn hàng ở đâu cả, nên đây là nguồn duy nhất.
- [ ] API thêm, sửa, xoá đơn; nút "Ghi nhận đơn" trên hồ sơ khách. Đơn có: số tiền, ngày đặt, hạn trả, ngày trả.
- [ ] Sau mỗi thay đổi đơn: cập nhật `da_mua` trong ghi chú, tính lại điểm.

**Xếp hạng**

- [ ] `score.ts` là hàm thuần: nhận danh sách khách kèm đơn và trọng số, trả điểm từng tiêu chí và hạng. Công thức ở mục 5.3.4.
- [ ] Trọng số là cài đặt module, mặc định 40, 20, 25, 15. Tổng khác 100 thì từ chối lưu.
- [ ] "Dễ phục vụ" chủ chấm tay trên hồ sơ, lưu trong `crm_scores.ease`. Chưa chấm thì khách đó chưa có điểm tổng, hiện "thiếu 1 tiêu chí".
- [ ] "Giới thiệu": thuộc tính `gioi_thieu_boi: "[[slug]]"` trên ghi chú khách được giới thiệu. Đếm bằng `backlinks`.
- [ ] Ghi `hang` vào ghi chú. Chỉ khách có ít nhất một đơn mới có hạng.

**Chân dung**

- [ ] `portrait.ts`: một lượt `lean` nhận hai nhóm (A và còn lại), mỗi khách gồm thẻ, nguồn, và khối "Khách cần gì", bọc `untrusted`. Đòi `{ traits: [{ text, inA: [id], inRest: [id] }] }`, tối đa 5 đặc điểm.
- [ ] Code đếm lại tỷ lệ từ danh sách id; id không tồn tại thì bỏ. Không dùng con số agent tự nêu.
- [ ] Ghi `khach-hang/_chan-dung-khach-tot.md`. Nhóm A dưới 5 khách thì thêm dòng "giả thuyết, cần thêm dữ liệu".
- [ ] `match.ts`: với mỗi khách chưa mua, tính số đặc điểm khớp. Phần khớp theo thẻ và nguồn làm bằng code; không gọi agent cho từng khách.

**Bốn màn**

- [ ] Giai đoạn (bảng kéo thả, thay trang `/m/care/customers`), Tất cả khách (bảng, cột là thuộc tính, có bộ lọc lưu được), Hồ sơ (thuộc tính, xem "file gốc", khách cần gì, nhật ký, đơn hàng, mức giống nhóm A), Khách tốt nhất.
- [ ] Chưa có đơn nào: màn Khách tốt nhất hiện hướng dẫn ghi nhận đơn. Không hiện số mẫu.
- [ ] Kéo thẻ sang cột khác gọi `customers.update`; ghi chú đổi theo qua T08.

## Test

- `score.test.ts`: bảng ví dụ 10 khách ra đúng thứ tự và hạng; trọng số tổng 90 bị từ chối; khách không có đơn không có hạng; hai khách đồng điểm ở ranh giới A và B được xử lý ổn định (cùng hạng cao hơn).
- `portrait.test.ts`: agent giả trả id lạ và tỷ lệ sai; kết quả ghi ra chỉ có id thật và tỷ lệ do code đếm.
- Thêm đơn làm `da_mua` và `hang` trong file đổi.

## Xong khi

- `npx vitest run modules/crm` qua.
- Bốn màn mở được ở `?mock=1` và với dữ liệu thật.

## Ghi chú

Nếu sau này có nguồn đơn hàng thật (bảng tính, phần mềm bán hàng), viết một bộ nhập ghi vào `crm_orders`. Đừng cho màn đọc thẳng nguồn ngoài.
