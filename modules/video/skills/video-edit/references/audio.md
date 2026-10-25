# Âm thanh: mức LUFS, nhạc nền, tiếng động

Máy trộn và chuẩn hoá. Bạn chọn **nhạc nào, tiếng động ở đâu, to nhỏ ra sao so với giọng**. Con số chuẩn lấy từ hồ sơ kênh (`project show` → `profile.audio`); nếu hồ sơ chưa có thì máy dùng mặc định bên dưới.

## Mức âm đích (LUFS, càng gần 0 càng to)

| Lớp | Mặc định | Ý nghĩa |
|---|---|---|
| Giọng nói | **-16 LUFS** | máy đưa giọng về mức này trước khi trộn |
| Nhạc nền | **-34 LUFS** | thấp hơn giọng khoảng 18 LU: nghe thấy nhưng không lấn giọng |
| Tổng cuối | **-15.5 LUFS** | `loudnorm` sau khi xuất, hợp TikTok/Reels/Shorts (khoảng -14 đến -16) |
| Tốc độ nói | ×1.0 | `speechRate` của hồ sơ; chủ kênh nói chậm có thể đặt 1.05 đến 1.1 |

Bạn **không** điền những con số LUFS vào plan. `music.gainDb` là **tinh chỉnh** quanh mức nhạc của hồ sơ (`musicLufs − voiceLufs`, mặc định -34 − (-16) = -18 dB dưới giọng). Mặc định `0`; bài rất to hoặc rất nhỏ so với bài khác thì bù khoảng -6 đến +3 dB. Giá trị từ -12 trở xuống được hiểu là mức tuyệt đối so với giọng (cách ghi của plan cũ), nên đừng ghi những số đó để tinh chỉnh.

## Nhạc nền (`music`)

- Chọn theo `style.musicMoods` (bảng ở `styles.md`) rồi lọc bằng `assets search "<mood>" --kind bgm`. Mục phải `available: true` và chưa bị tắt.
- `mood` trong plan ghi lại mood đã chọn (VD "Tập trung").
- **`duck: true`** khi video có giọng nói gần như suốt (hầu hết trường hợp): máy hạ nhạc thêm khi người nói và đưa nhạc lên ở khoảng lặng. `duck: false` chỉ khi nhạc là chủ đạo (đoạn montage không lời).
- Bỏ nhạc hoàn toàn khi: phong cách `none` về nhạc (`/giaoduc` khi có định nghĩa quan trọng, `/podcast` khi hai người đối thoại), video đã có nhạc nền trong cảnh quay, kênh cấm nhạc, hoặc kho không có bài hợp. **Không có nhạc còn hơn nhạc sai mood.**
- Nhạc `attribution` (CC-BY): ghi nguồn vào `meta.caption`.
- Không chọn bài có lời hát cho video có lời nói.

## Tiếng động (SFX)

Mật độ theo `style.sfxDensity`; số bên dưới là điểm chuẩn mỗi 10 giây video đã dựng:

| Mật độ | Số SFX / 10 giây | Dùng cho |
|---|---|---|
| `none` | 0 | bài giảng, podcast, tâm sự |
| `low` | tối đa 1 | kiến thức, hướng dẫn, tài chính |
| `medium` | 1 đến 2 | công nghệ, review, vlog nhanh |
| `high` | 2 đến 3 | bán hàng, hài, giải trí |

Quy tắc đặt:

1. SFX đi **cùng một sự kiện nhìn thấy**: hiệu ứng chữ bật lên (`pop`, `ding`), chuyển ý (vút/whoosh), số nhảy (tích tắc rồi ding), cảnh B-roll vào (vút nhẹ), điểm nhấn cuối (sub drop).
2. `at` (giây video đã dựng) trùng hoặc **trước 0,05 giây** so với sự kiện hình, không sau.
3. `gainDb` từ **-12 đến -6** so với giọng (mặc định -8). Âm sắc trầm (sub drop) nhỏ hơn âm sắc cao (ding).
4. Không SFX khi người nói đang nói câu quan trọng bằng giọng nhỏ, hay cùng lúc hai SFX. Cách nhau ít nhất 1 giây.
5. Cùng một tiếng lặp lại quá 3 lần trong video thì đổi tiếng khác.
6. Dùng đúng `assetId` từ `assets search "<tên>" --kind sfx` (vút, dâng lên, sub drop, ding, tích tắc, bụp, glitch, bong bóng là các tiếng có sẵn trong kho khởi đầu).

## Khi hồ sơ kênh có luật riêng

`taste` của kênh thắng: "không nhạc buồn", "không tiếng động" nghĩa là bỏ hẳn; "nhạc nhỏ hơn nữa" nghĩa là hạ `gainDb` thêm 3 đến 6 dB hoặc nhắc chủ kênh đổi `musicLufs` trong hồ sơ (mức này là thiết lập kênh, bạn không tự đổi).

Ghi bằng chứng: `log audio "nhạc <tên> (<mood>), duck bật; <n> SFX theo mật độ <medium> (~<x>/10s); giọng -16 / nhạc -34 / cuối -15.5 LUFS theo hồ sơ"`.
