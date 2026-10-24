import { ASSET_KINDS, type AssetKind, type VideoAsset } from '../types.js';
import { CATEGORY_LABEL, CURATED_FONTS, fontSlug } from '../library/fonts-data.js';
import { getLibrary } from '../library/store.js';
import type { LibraryAsset } from '../library/store.js';

const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'ogg', 'aac'];
/** File extensions the library accepts per kind (uploads, rescan, seed). Effects and caption styles have no files. */
export const KIND_EXTENSIONS: Record<AssetKind, string[]> = {
  bgm: AUDIO_EXT,
  sfx: AUDIO_EXT,
  font: ['ttf', 'otf'],
  lut: ['cube'],
  video: ['mp4', 'mov', 'webm'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'],
  background: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'],
  icon: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'],
  overlay: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif', 'mov'],
  effect: [],
  caption: [],
};
export const MISSING_LICENSE = 'CC0/tự tổng hợp (cần bổ sung file)';

export function normalizeText(text: string): string {
  return text.replace(/đ/g, 'd').replace(/Đ/g, 'D').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function entry(kind: AssetKind, slug: string, name: string, description: string, tags: string[], extra: Partial<VideoAsset> = {}): VideoAsset {
  return { id: `${kind}:${slug}`, kind, name, description, tags, source: 'builtin', available: false, ...extra };
}

const EFFECTS: VideoAsset[] = [
  entry('effect', 'two-tier-hook', 'Tiêu đề hai tầng', 'Dòng nhỏ dẫn dắt phía trên, dòng lớn chốt ý phía dưới. Dùng cho hook 3 giây đầu.', ['hook', 'tiêu đề', 'mở đầu']),
  entry('effect', 'karaoke-follow', 'Chữ chạy theo lời', 'Từng từ sáng lên đúng lúc người nói đọc tới. Hợp podcast và lời dài.', ['karaoke', 'phụ đề', 'từng từ']),
  entry('effect', 'keyword-pop', 'Từ khoá bật lên', 'Từ quan trọng phóng to rồi về chỗ cũ. Dùng cho thuật ngữ, lợi ích, câu gây cười.', ['nhấn', 'từ khoá', 'pop']),
  entry('effect', 'compare-ab', 'So sánh A | B', 'Chia đôi khung để đặt hai thứ cạnh nhau: trước và sau, cũ và mới, A và B.', ['so sánh', 'trước sau', 'versus']),
  entry('effect', 'stacked-list', 'Danh sách xếp tầng', 'Các ý hiện lần lượt thành cột dọc khi người nói liệt kê.', ['danh sách', 'liệt kê', 'list']),
  entry('effect', 'count-up', 'Số nhảy', 'Con số chạy từ 0 tới giá trị thật. Dùng cho doanh thu, phần trăm, lượt xem.', ['số liệu', 'con số', 'đếm']),
  entry('effect', 'hand-circle', 'Khoanh tròn tay', 'Nét vẽ tay khoanh quanh một chỗ trên hình để chỉ người xem nhìn vào đâu.', ['khoanh', 'chỉ', 'vẽ tay']),
  entry('effect', 'comment-bubble', 'Bong bóng bình luận', 'Khung bình luận giả lập hiện ra khi trả lời câu hỏi hay phản ứng.', ['bình luận', 'phản hồi', 'comment']),
  entry('effect', 'glitch-decode', 'Chữ giải mã / glitch', 'Chữ nhiễu rồi sáng rõ dần. Hợp tin công nghệ, AI, hacker.', ['công nghệ', 'glitch', 'giải mã']),
  entry('effect', 'glow-text', 'Chữ phát sáng', 'Chữ có viền sáng neon trên nền tối. Dùng khi ra mắt, công bố, khoảnh khắc "wow".', ['neon', 'ra mắt', 'phát sáng']),
  entry('effect', 'slide-up', 'Chữ trượt lên', 'Dòng chữ trượt từ dưới vào, êm và gọn. Dùng cho tiêu đề, tên người, tin tức.', ['trượt', 'tiêu đề', 'tên']),
  entry('effect', 'soft-blur', 'Chữ mờ dần', 'Chữ hiện từ mờ sang rõ, chậm. Dùng cho đoạn tâm sự, câu đắt giá.', ['tâm sự', 'mờ', 'cảm xúc']),
  entry('effect', 'handwriting', 'Chữ viết tay', 'Chữ được viết ra từng nét như bút thật. Hợp vlog và nội dung gần gũi.', ['viết tay', 'vlog', 'gần gũi']),
  entry('effect', 'typewriter', 'Máy đánh chữ', 'Chữ gõ ra từng ký tự kèm con trỏ nhấp nháy. Hợp hướng dẫn, đoạn code, lệnh.', ['gõ chữ', 'hướng dẫn', 'code']),
  entry('effect', 'numbered-steps', 'Các bước đánh số', 'Số thứ tự lớn kèm tên bước. Dùng khi người nói chuyển sang bước tiếp theo.', ['bước', 'quy trình', 'đánh số']),
  entry('effect', 'chapter-opener', 'Mở chương', 'Thẻ tên chương toàn khung vài giây. Dùng cho video dài chia phần.', ['chương', 'phần', 'chuyển đoạn']),
  entry('effect', 'sticker-label', 'Nhãn dán', 'Nhãn màu ghi giá, tên món, ưu đãi hoặc chú thích ngắn, hơi nghiêng cho vui mắt.', ['nhãn', 'giá', 'sticker']),
  entry('effect', 'underline', 'Gạch chân', 'Một nét gạch chạy dưới cụm từ quan trọng. Nhẹ hơn khoanh tròn, hợp video nghiêm túc.', ['gạch chân', 'nhấn', 'nhẹ']),
  entry('effect', 'pointing-arrow', 'Mũi tên chỉ', 'Mũi tên hiện ra chỉ vào nút, sản phẩm hay chi tiết trên màn hình.', ['mũi tên', 'chỉ', 'màn hình']),
  entry('effect', 'outro-follow', 'Thẻ kêu gọi theo dõi', 'Thẻ cuối video có tên kênh và lời mời theo dõi hoặc nhắn tin.', ['cta', 'kết thúc', 'theo dõi']),
];

const CAPTIONS: VideoAsset[] = [
  entry('caption', 'pair-words', 'Hai từ một lần', 'Mỗi lần hiện một cặp hai từ, đổi nhanh theo lời. Hợp video nhịp nhanh.', ['2 từ', 'nhanh']),
  entry('caption', 'behind-subject', 'Chữ sau lưng người', 'Chữ nằm phía sau người nói, người đè lên chữ. Cần nền rõ, tách người được.', ['điện ảnh', 'phía sau']),
  entry('caption', 'boxed', 'Chữ trong khung', 'Chữ trắng trên khung nền tối bo góc. Dễ đọc trên mọi nền.', ['khung', 'dễ đọc']),
  entry('caption', 'outline-highlight', 'Viền đen, tô vàng', 'Chữ trắng viền đen dày, từ nhấn tô vàng. Kiểu phổ biến của video ngắn.', ['viền', 'vàng', 'tiktok']),
  entry('caption', 'karaoke', 'Karaoke', 'Cả câu hiện sẵn, từng từ đổi màu theo lời nói.', ['theo lời', 'đổi màu']),
  entry('caption', 'single-word-pop', 'Từng từ bật lên', 'Mỗi từ một lần, phóng nhẹ khi hiện. Hợp thời trang, làm đẹp, cảm xúc.', ['1 từ', 'bật']),
  entry('caption', 'bottom-clean', 'Dưới màn hình, gọn', 'Phụ đề trắng ở dưới, đổ bóng nhẹ, không tô màu. Hợp bài giảng, tâm sự.', ['sạch', 'giản dị']),
  entry('caption', 'highlight-bar', 'Thanh tô nền từ khoá', 'Từ khoá có thanh màu nằm dưới như bút dạ quang.', ['dạ quang', 'từ khoá']),
  entry('caption', 'typewriter-caption', 'Gõ chữ từng ký tự', 'Phụ đề hiện dần từng ký tự như đang gõ.', ['gõ chữ', 'hướng dẫn']),
  entry('caption', 'bold-uppercase', 'In hoa đậm', 'Chữ in hoa dày, chiếm bề ngang khung. Hợp bán hàng và thể thao.', ['in hoa', 'mạnh']),
  entry('caption', 'gradient-glow', 'Chuyển màu phát sáng', 'Chữ chuyển màu với quầng sáng. Hợp công nghệ và ra mắt.', ['neon', 'chuyển màu']),
  entry('caption', 'handwritten', 'Viết tay', 'Phụ đề nét tay mềm. Hợp vlog và nội dung đời thường.', ['viết tay', 'vlog']),
];

const SFX: [string, string, string][] = [
  ['whoosh', 'Vút', 'Tiếng gió lướt qua. Dùng khi chuyển cảnh hoặc chữ trượt vào.'],
  ['pop', 'Bụp', 'Tiếng bật nhỏ. Dùng khi nhãn, từ khoá hoặc biểu tượng hiện ra.'],
  ['ding', 'Ding', 'Chuông ngắn. Dùng khi chốt một ý đúng, một kết quả tốt, một bước hoàn thành.'],
  ['typing', 'Gõ phím', 'Tiếng bàn phím. Dùng cùng chữ máy đánh hoặc khi nói về làm việc, code.'],
  ['punch', 'Đấm', 'Cú nện ngắn. Dùng cho câu chốt mạnh hoặc cú zoom vào mặt.'],
  ['riser', 'Dâng lên', 'Âm thanh tăng dần. Đặt trước khoảnh khắc lộ kết quả.'],
  ['glitch', 'Glitch', 'Tiếng nhiễu số. Dùng với chữ giải mã, tin công nghệ.'],
  ['mouse-click', 'Click chuột', 'Tiếng bấm. Dùng khi hướng dẫn thao tác trên màn hình.'],
  ['sub-drop', 'Sub drop', 'Tiếng trầm rơi xuống. Dùng sau riser hoặc ở điểm đổi ý lớn.'],
  ['bubble', 'Bong bóng', 'Tiếng bọt nhẹ vui tai. Dùng cho bình luận, sticker, nội dung nhẹ nhàng.'],
  ['tick-tock', 'Tích tắc', 'Tiếng đồng hồ. Dùng khi nói về thời gian, hạn chót, đếm ngược.'],
];

const BGM: [string, string, string][] = [
  ['nang-luong', 'Năng lượng', 'Nhịp nhanh, dồn dập. Hợp bán hàng, thể thao, công nghệ.'],
  ['tuoi-sang', 'Tươi sáng', 'Vui, nhẹ, nhiều giai điệu. Hợp vlog, du lịch, ẩm thực.'],
  ['tap-trung', 'Tập trung', 'Nhịp đều, ít giai điệu. Hợp kiến thức, hướng dẫn, tài chính.'],
  ['hoi-hop', 'Hồi hộp', 'Căng, tăng dần. Hợp tiết lộ kết quả, điện ảnh.'],
  ['suy-tu', 'Suy tư', 'Chậm, trầm, có khoảng lặng. Hợp tâm sự, bài học.'],
  ['binh-yen', 'Bình yên', 'Êm, mở, rất nhỏ. Hợp bài giảng, podcast, bất động sản.'],
];

const OTHERS: VideoAsset[] = [
  entry('background', 'dark-grid', 'Nền lưới tối', 'Nền đen có lưới mờ. Dùng cho video công nghệ khi cần nền cho chữ.', ['công nghệ', 'tối']),
  entry('background', 'paper-warm', 'Nền giấy ấm', 'Nền kem có vân giấy. Dùng cho bài giảng, tâm sự.', ['giấy', 'ấm']),
  entry('background', 'gradient-sunset', 'Nền chuyển màu hoàng hôn', 'Chuyển màu cam hồng. Dùng cho thẻ chương và thẻ kết.', ['chuyển màu', 'tươi']),
  entry('overlay', 'film-grain', 'Hạt phim', 'Lớp hạt nhẹ tạo cảm giác phim. Hợp điện ảnh và vlog.', ['phim', 'hạt']),
  entry('overlay', 'light-leak', 'Rò sáng', 'Vệt sáng ấm lướt qua khung, dùng ở điểm chuyển cảnh.', ['ánh sáng', 'chuyển cảnh']),
  entry('overlay', 'vignette', 'Tối góc', 'Làm tối bốn góc để dồn mắt vào giữa khung.', ['viền tối', 'tập trung']),
  entry('lut', 'warm-film', 'Màu phim ấm', 'Tông ấm, đen nâng nhẹ. Hợp vlog, ẩm thực, du lịch.', ['ấm', 'phim']),
  entry('lut', 'cool-tech', 'Màu lạnh công nghệ', 'Tông xanh lạnh, tương phản cao. Hợp công nghệ và tin tức.', ['lạnh', 'công nghệ']),
  entry('lut', 'clean-bright', 'Màu sáng sạch', 'Sáng, da tự nhiên, ít bão hoà. Hợp bán hàng và làm đẹp.', ['sáng', 'sạch']),
  entry('lut', 'teal-orange', 'Xanh ngọc & cam', 'Bóng tối ngả xanh ngọc, vùng sáng ngả cam. Kiểu điện ảnh phổ biến.', ['điện ảnh', 'teal', 'cam']),
  entry('lut', 'bw', 'Đen trắng', 'Bỏ màu, giữ tương phản nhẹ. Hợp nội dung nghiêm túc hoặc hoài niệm.', ['đen trắng', 'hoài niệm']),
  entry('lut', 'contrast', 'Tương phản cao', 'Tối sâu hơn, sáng rõ hơn. Hợp video cần lực nhìn mạnh.', ['tương phản', 'mạnh']),
  entry('lut', 'fade', 'Phai màu', 'Đen nâng lên, màu nhạt đi. Hợp vlog hoài niệm, nhẹ nhàng.', ['phai', 'vlog']),
];

/** Catalog entries without disk state: the static list the library merges with its manifest. */
export function builtinCatalog(): VideoAsset[] {
  const out: VideoAsset[] = [...EFFECTS, ...CAPTIONS, ...OTHERS];
  for (const font of CURATED_FONTS) {
    out.push(entry('font', fontSlug(font.family), font.family, `${font.note} Có dấu tiếng Việt, giấy phép SIL OFL.`.trim(), ['font', 'OFL', 'tiếng Việt', CATEGORY_LABEL[font.category]], {
      license: 'SIL OFL 1.1',
    }));
  }
  for (const [slug, name, description] of SFX) {
    out.push(entry('sfx', slug, name, description, [slug, 'tiếng động'], { license: MISSING_LICENSE }));
  }
  for (const [slug, name, description] of BGM) {
    out.push(entry('bgm', slug, name, description, [slug, 'nhạc nền', 'nhạc'], { mood: name, license: MISSING_LICENSE }));
  }
  return out;
}

/** Moods of the builtin music entries: slug -> Vietnamese label (also the `mood` value of tracks). */
export const BGM_MOODS: readonly { slug: string; label: string }[] = BGM.map(([slug, label]) => ({ slug, label }));

export function listAssets(root: string, filter: { kind?: string; q?: string; source?: string; enabled?: boolean } = {}): { kinds: { kind: AssetKind; label: string; count: number }[]; assets: LibraryAsset[] } {
  return filterLibrary(getLibrary(root), filter);
}

export function filterLibrary(all: LibraryAsset[], filter: { kind?: string; q?: string; source?: string; enabled?: boolean } = {}): { kinds: { kind: AssetKind; label: string; count: number }[]; assets: LibraryAsset[] } {
  const q = filter.q ? normalizeText(filter.q.trim()) : '';
  let matched = all;
  if (filter.source) matched = matched.filter((a) => a.source === filter.source);
  if (filter.enabled) matched = matched.filter((a) => a.enabled !== false);
  if (q) matched = matched.filter((a) => normalizeText([a.name, a.description ?? '', a.mood ?? '', a.license ?? '', ...a.tags].join(' ')).includes(q));
  const kinds = ASSET_KINDS.map(({ kind, label }) => ({ kind, label, count: matched.filter((a) => a.kind === kind).length }));
  const assets = filter.kind ? matched.filter((a) => a.kind === filter.kind) : matched;
  return { kinds, assets };
}
