// What the starter pack installs, besides fonts (fonts-data.ts) and music (music-data.ts).

export interface KenneyEntry {
  /** File name inside the zip's Audio/ folder, without extension. */
  file: string;
  /** Library slug; the asset id is `sfx:<builtin>` when `builtin` is set, else `seed:sfx:kenney-<slug>`. */
  slug: string;
  name: string;
  tags: string[];
  /** Builtin catalog sfx slug this file provides (catalog/assets.ts). */
  builtin?: string;
}

export interface KenneyPack {
  pack: 'interface-sounds' | 'impact-sounds' | 'digital-audio';
  title: string;
  /** The page that links the zip; the real link is read from it and `fallbackZip` is used if that fails. */
  page: string;
  fallbackZip: string;
  entries: KenneyEntry[];
}

const k = (file: string, slug: string, name: string, tags: string[], builtin?: string): KenneyEntry => ({ file, slug, name, tags, ...(builtin ? { builtin } : {}) });

export const KENNEY_PACKS: KenneyPack[] = [
  {
    pack: 'interface-sounds', title: 'Kenney Interface Sounds', page: 'https://kenney.nl/assets/interface-sounds',
    fallbackZip: 'https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip',
    entries: [
      k('click_001', 'click-1', 'Bấm chuột 1', ['click', 'giao diện']),
      k('click_002', 'click-2', 'Click chuột', ['click', 'chuột', 'giao diện'], 'mouse-click'),
      k('click_003', 'click-3', 'Bấm chuột 3', ['click', 'giao diện']),
      k('select_001', 'select-1', 'Chọn 1', ['chọn', 'giao diện']),
      k('select_002', 'select-2', 'Chọn 2', ['chọn', 'giao diện']),
      k('select_004', 'select-4', 'Chọn 4', ['chọn', 'giao diện']),
      k('confirmation_001', 'confirm-1', 'Xác nhận 1', ['xác nhận', 'đúng', 'thành công']),
      k('confirmation_002', 'confirm-2', 'Xác nhận 2', ['xác nhận', 'đúng', 'thành công']),
      k('confirmation_004', 'confirm-4', 'Xác nhận 4', ['xác nhận', 'đúng', 'thành công']),
      k('switch_001', 'switch-1', 'Công tắc 1', ['công tắc', 'giao diện']),
      k('switch_005', 'switch-5', 'Công tắc 5', ['công tắc', 'giao diện']),
      k('toggle_001', 'toggle-1', 'Bật tắt 1', ['bật tắt', 'giao diện']),
      k('bong_001', 'bong', 'Bong', ['bong', 'chuông', 'thông báo']),
      k('glitch_001', 'glitch-1', 'Nhiễu số 1', ['glitch', 'nhiễu', 'công nghệ']),
      k('glitch_002', 'glitch-2', 'Nhiễu số 2', ['glitch', 'nhiễu', 'công nghệ']),
      k('glitch_004', 'glitch-4', 'Nhiễu số 4', ['glitch', 'nhiễu', 'công nghệ']),
      k('scratch_001', 'scratch-1', 'Quẹt 1', ['quẹt', 'scratch']),
      k('drop_001', 'drop-1', 'Giọt rơi 1', ['rơi', 'giọt']),
      k('pluck_001', 'pluck-1', 'Gảy dây 1', ['gảy', 'nốt']),
      k('glass_001', 'glass-1', 'Kính 1', ['kính', 'ly']),
      k('glass_003', 'glass-3', 'Kính 3', ['kính', 'ly']),
      k('question_001', 'question-1', 'Câu hỏi 1', ['hỏi', 'thắc mắc']),
      k('error_001', 'error-1', 'Sai 1', ['sai', 'lỗi', 'cảnh báo']),
      k('tick_001', 'tick-1', 'Tách 1', ['tách', 'tick']),
      k('open_001', 'open-1', 'Mở 1', ['mở', 'giao diện']),
      k('maximize_001', 'maximize-1', 'Phóng to 1', ['phóng to', 'giao diện']),
    ],
  },
  {
    pack: 'impact-sounds', title: 'Kenney Impact Sounds', page: 'https://kenney.nl/assets/impact-sounds',
    fallbackZip: 'https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip',
    entries: [
      k('impactPunch_heavy_000', 'punch-heavy-1', 'Đấm', ['đấm', 'va đập', 'mạnh'], 'punch'),
      k('impactPunch_heavy_001', 'punch-heavy-2', 'Đấm mạnh 2', ['đấm', 'va đập', 'mạnh']),
      k('impactPunch_medium_000', 'punch-medium-1', 'Đấm vừa 1', ['đấm', 'va đập']),
      k('impactGeneric_light_000', 'generic-light-1', 'Va chạm nhẹ 1', ['va đập', 'nhẹ']),
      k('impactMetal_heavy_000', 'metal-heavy-1', 'Va kim loại nặng 1', ['kim loại', 'va đập', 'nặng']),
      k('impactBell_heavy_000', 'bell-heavy-1', 'Chuông nặng 1', ['chuông', 'va đập']),
      k('impactSoft_heavy_000', 'soft-heavy-1', 'Va mềm nặng 1', ['mềm', 'va đập', 'thịch']),
      k('impactWood_heavy_000', 'wood-heavy-1', 'Va gỗ nặng 1', ['gỗ', 'va đập']),
      k('impactGlass_heavy_000', 'glass-heavy-1', 'Va kính nặng 1', ['kính', 'va đập']),
      k('impactPlate_heavy_000', 'plate-heavy-1', 'Va tấm kim loại 1', ['tấm', 'kim loại', 'va đập']),
    ],
  },
  {
    pack: 'digital-audio', title: 'Kenney Digital Audio', page: 'https://kenney.nl/assets/digital-audio',
    fallbackZip: 'https://kenney.nl/media/pages/assets/digital-audio/216eac4753-1677590265/kenney_digital-audio.zip',
    entries: [
      k('powerUp1', 'power-up-1', 'Tăng sức mạnh 1', ['tăng', 'game', 'công nghệ']),
      k('powerUp4', 'power-up-4', 'Tăng sức mạnh 4', ['tăng', 'game', 'công nghệ']),
      k('powerUp7', 'power-up-7', 'Tăng sức mạnh 7', ['tăng', 'game', 'công nghệ']),
      k('phaserUp1', 'phaser-up-1', 'Quét lên 1', ['quét', 'lên', 'công nghệ']),
      k('phaserUp3', 'phaser-up-3', 'Quét lên 3', ['quét', 'lên', 'công nghệ']),
      k('phaserDown1', 'phaser-down-1', 'Quét xuống 1', ['quét', 'xuống', 'công nghệ']),
      k('lowDown', 'low-down', 'Trầm xuống', ['trầm', 'xuống']),
      k('highUp', 'high-up', 'Cao lên', ['cao', 'lên']),
      k('threeTone1', 'three-tone-1', 'Ba nốt 1', ['ba nốt', 'thông báo']),
      k('pepSound1', 'pep-1', 'Bật nảy 1', ['nảy', 'vui']),
      k('pepSound3', 'pep-3', 'Bật nảy 3', ['nảy', 'vui']),
      k('zap1', 'zap-1', 'Điện giật 1', ['điện', 'zap', 'công nghệ']),
      k('laser1', 'laser-1', 'Tia laser 1', ['laser', 'công nghệ']),
      k('spaceTrash1', 'space-trash-1', 'Tạp âm không gian 1', ['không gian', 'tạp âm']),
    ],
  },
];

export interface Sticker { hex: string; name: string; tags: string[] }
const s = (hex: string, name: string, ...tags: string[]): Sticker => ({ hex, name, tags });

/** Noto Emoji codepoints (file `2D/png/128/emoji_u<hex>.png`). A 404 is skipped at download time. */
export const NOTO_STICKERS: Sticker[] = [
  s('1f525', 'Lửa', 'hot', 'nóng', 'xu hướng'), s('2b50', 'Ngôi sao', 'sao', 'đánh giá'), s('1f31f', 'Sao sáng', 'sao', 'nổi bật'),
  s('2728', 'Lấp lánh', 'sparkle', 'đẹp', 'mới'), s('1f4a5', 'Nổ', 'bùng nổ', 'va chạm'), s('1f4af', '100 điểm', 'tuyệt đối', 'điểm'),
  s('2705', 'Dấu tích', 'đúng', 'xong', 'đạt'), s('274c', 'Dấu X', 'sai', 'không', 'sai'), s('26a0', 'Cảnh báo', 'cảnh báo', 'lưu ý'),
  s('2757', 'Chấm than', 'nhấn mạnh', 'lưu ý'), s('2753', 'Chấm hỏi', 'câu hỏi', 'thắc mắc'),
  s('1f449', 'Chỉ sang phải', 'chỉ', 'mũi tên', 'tay'), s('1f447', 'Chỉ xuống', 'chỉ', 'mũi tên', 'tay'), s('1f446', 'Chỉ lên', 'chỉ', 'mũi tên', 'tay'),
  s('1f44d', 'Like', 'thích', 'tay', 'đồng ý'), s('1f44e', 'Không thích', 'dislike', 'tay'), s('1f44f', 'Vỗ tay', 'khen', 'tay'),
  s('1f64f', 'Chắp tay', 'cảm ơn', 'xin'), s('1f4aa', 'Cơ bắp', 'mạnh', 'cố lên'), s('1f389', 'Pháo giấy', 'ăn mừng', 'tiệc'),
  s('1f38a', 'Bóng pháo', 'ăn mừng', 'tiệc'), s('1f3c6', 'Cúp', 'thắng', 'giải thưởng'), s('1f947', 'Huy chương vàng', 'nhất', 'giải thưởng'),
  s('1f4b0', 'Túi tiền', 'tiền', 'doanh thu'), s('1f4b5', 'Tiền giấy', 'tiền', 'đô la'), s('1f4b8', 'Tiền bay', 'tiền', 'chi phí'),
  s('1f4c8', 'Biểu đồ đi lên', 'tăng', 'số liệu', 'doanh thu'), s('1f4c9', 'Biểu đồ đi xuống', 'giảm', 'số liệu'),
  s('1f680', 'Tên lửa', 'tăng tốc', 'khởi động'), s('1f4a1', 'Bóng đèn', 'ý tưởng', 'mẹo'), s('1f9e0', 'Bộ não', 'thông minh', 'kiến thức'),
  s('1f440', 'Đôi mắt', 'nhìn', 'xem'), s('1f60d', 'Mắt trái tim', 'thích', 'yêu', 'mặt cười'), s('1f602', 'Cười ra nước mắt', 'hài', 'mặt cười'),
  s('1f923', 'Cười lăn', 'hài', 'mặt cười'), s('1f60e', 'Kính râm', 'ngầu', 'mặt cười'), s('1f914', 'Đang nghĩ', 'suy nghĩ', 'mặt cười'),
  s('1f631', 'Hét', 'sốc', 'mặt cười'), s('1f62e', 'Há miệng', 'ngạc nhiên', 'mặt cười'), s('1f92f', 'Nổ đầu', 'sốc', 'mặt cười'),
  s('1f622', 'Khóc', 'buồn', 'mặt cười'), s('1f621', 'Giận', 'giận', 'mặt cười'), s('1f970', 'Mặt cười ba tim', 'yêu', 'mặt cười'),
  s('1f60a', 'Cười tươi', 'vui', 'mặt cười'), s('1f642', 'Cười nhẹ', 'vui', 'mặt cười'), s('1f609', 'Nháy mắt', 'tinh nghịch', 'mặt cười'),
  s('1f973', 'Mặt tiệc', 'ăn mừng', 'mặt cười'), s('1f92b', 'Suỵt', 'bí mật', 'mặt cười'),
  s('2764', 'Tim đỏ', 'yêu', 'tim'), s('1f496', 'Tim lấp lánh', 'yêu', 'tim'), s('1f494', 'Tim vỡ', 'buồn', 'tim'),
  s('1f4ac', 'Bong bóng thoại', 'bình luận', 'chat'), s('1f4e2', 'Loa', 'thông báo', 'quảng cáo'), s('1f514', 'Chuông', 'thông báo', 'nhắc'),
  s('23f0', 'Đồng hồ báo thức', 'thời gian', 'hạn chót'), s('231b', 'Đồng hồ cát', 'thời gian', 'chờ'),
  s('1f4f1', 'Điện thoại', 'điện thoại', 'công nghệ'), s('1f4bb', 'Laptop', 'máy tính', 'công nghệ'), s('1f4f7', 'Máy ảnh', 'chụp ảnh', 'quay'),
  s('1f3ac', 'Bảng clapper', 'phim', 'quay'), s('1f3a4', 'Micro', 'thu âm', 'podcast'), s('1f3a7', 'Tai nghe', 'nghe', 'nhạc'),
  s('1f3b5', 'Nốt nhạc', 'nhạc', 'âm thanh'), s('1f4dd', 'Ghi chú', 'ghi chú', 'viết'), s('1f4cc', 'Ghim', 'ghim', 'lưu ý'),
  s('1f517', 'Liên kết', 'link', 'đường dẫn'), s('1f512', 'Khoá', 'bảo mật', 'riêng tư'), s('1f513', 'Mở khoá', 'mở', 'bảo mật'),
  s('1f6d2', 'Giỏ hàng', 'mua sắm', 'bán hàng'), s('1f381', 'Quà', 'tặng', 'ưu đãi'), s('1f3af', 'Mục tiêu', 'đích', 'trúng'),
  s('1f4e6', 'Hộp hàng', 'đóng gói', 'vận chuyển'), s('1f69a', 'Xe tải', 'giao hàng', 'vận chuyển'), s('2708', 'Máy bay', 'du lịch', 'bay'),
  s('1f3e0', 'Nhà', 'nhà', 'bất động sản'), s('1f355', 'Pizza', 'ăn', 'ẩm thực'), s('2615', 'Cà phê', 'uống', 'ẩm thực'),
  s('1f354', 'Hamburger', 'ăn', 'ẩm thực'), s('1f35c', 'Tô mì', 'ăn', 'ẩm thực'), s('1f9cb', 'Trà sữa', 'uống', 'ẩm thực'),
  s('1f48e', 'Kim cương', 'cao cấp', 'quý'), s('1f451', 'Vương miện', 'vua', 'cao cấp'), s('1f319', 'Trăng', 'đêm', 'ngủ'),
  s('2600', 'Mặt trời', 'nắng', 'ngày'), s('1f308', 'Cầu vồng', 'đẹp', 'màu sắc'), s('26a1', 'Tia chớp', 'nhanh', 'điện'),
  s('1f4a4', 'Zzz', 'ngủ', 'chán'), s('1f4a8', 'Gió vút', 'nhanh', 'chạy'), s('1f4a6', 'Giọt mồ hôi', 'mệt', 'nước'),
  s('1f44b', 'Vẫy tay', 'chào', 'tạm biệt'), s('1f91d', 'Bắt tay', 'hợp tác', 'thoả thuận'), s('270c', 'Dấu V', 'chiến thắng', 'tay'),
];

export const NOTO_EMOJI_LICENSE = 'Apache-2.0 (Noto Emoji)';
export const NOTO_EMOJI_REPO = 'https://github.com/googlefonts/noto-emoji';
