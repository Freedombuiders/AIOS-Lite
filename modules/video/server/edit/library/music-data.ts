// CC0 background music for the six moods. Every track was checked on its OpenGameArt page (2026-10-14):
// the licence list read exactly "CC0" and the file was linked from that page. Nothing here needs attribution;
// the authors' credit lines are kept in `author` and shown in the library as a courtesy.
// The moods were assigned from each page's tags and description. Listen before relying on a mood.

export interface MusicTrack {
  slug: string;
  title: string;
  author: string;
  mood: { slug: string; label: string };
  description: string;
  tags?: string[];
  license: string;
  /** Required credit line (CC-BY only). */
  attribution?: string;
  pageUrl: string;
  fileUrl: string;
  bpm?: number;
  /** Skip files longer than this (seconds). */
  maxSeconds?: number;
}

const OGA = 'https://opengameart.org';
const FILES = `${OGA}/sites/default/files`;
// Same slugs and labels as BGM_MOODS in catalog/assets.ts.
const MOODS: Record<string, { slug: string; label: string }> = {
  'nang-luong': { slug: 'nang-luong', label: 'Năng lượng' }, 'tuoi-sang': { slug: 'tuoi-sang', label: 'Tươi sáng' },
  'tap-trung': { slug: 'tap-trung', label: 'Tập trung' }, 'hoi-hop': { slug: 'hoi-hop', label: 'Hồi hộp' },
  'suy-tu': { slug: 'suy-tu', label: 'Suy tư' }, 'binh-yen': { slug: 'binh-yen', label: 'Bình yên' },
};
const mood = (slug: string) => MOODS[slug];
const cc0 = (moodSlug: string, slug: string, title: string, author: string, page: string, file: string, description: string, tags: string[]): MusicTrack => ({
  slug, title, author, mood: mood(moodSlug), description: `${description} Tác giả: ${author}.`, tags, license: 'CC0 1.0 (OpenGameArt)',
  pageUrl: `${OGA}/content/${page}`, fileUrl: `${FILES}/${file}`, maxSeconds: 600,
});

export const MUSIC_TRACKS: readonly MusicTrack[] = [
  cc0('nang-luong', 'shortcuts', 'Shortcuts', 'Zane Little Music', 'shortcuts', 'shortcuts.ogg', 'Điện tử breakbeat nhanh, dồn dập. Hợp bán hàng, công nghệ, thể thao.', ['edm', 'breakbeat', 'nhanh']),
  cc0('nang-luong', 'hella-bumps', 'Hella Bumps', 'The Cynic Project (cynicmusic)', 'hella-bumps-menu-music', 'hella%20bumps_0.mp3', 'House/dance vui và dồn nhịp. Hợp mở đầu và kết video.', ['house', 'dance', 'vui']),
  cc0('nang-luong', 'rhythm-factory', 'Rhythm Factory', 'Zane Little Music', 'rhythm-factory', 'rhythm_factory_0.mp3', 'Funky điện tử nhiều biến hoá, vui và nhanh.', ['funk', 'điện tử', 'vui']),
  cc0('nang-luong', 'virtual-rush', 'Virtual Rush', 'Vitalezzz', 'virtual-rush', 'virtual_rush_2.mp3', 'Điện tử synth nhịp mạnh, hợp công nghệ và hành động.', ['synth', 'điện tử', 'công nghệ']),
  cc0('tuoi-sang', 'sunflower-valley', 'Sunflower Valley', 'isaiah658', 'sunflower-valley', 'Sunflower-Valley-isaiah658_0.mp3', 'Giai điệu tươi vui, nhẹ. Hợp vlog, du lịch.', ['vui', 'giai điệu']),
  cc0('tuoi-sang', 'wednesday-night', 'Wednesday Night', 'Zane Little Music', 'wednesday-night-funk-fusion', 'wednesday_night.ogg', 'Funk fusion sạch và dễ chịu. Hợp đời sống, ẩm thực.', ['funk', 'jazz', 'dễ chịu']),
  cc0('tuoi-sang', 'summers', 'Summers', 'symphony', 'summers', 'symphony%20-%20summers_0.mp3', 'Điện tử vui, thanh bình như hội hè mùa hè.', ['hè', 'vui']),
  cc0('tuoi-sang', 'funky-house', 'Funky House', 'Of Far Different Nature', 'funky-house', 'Of%20Far%20Different%20Nature%20-%20Funky%20House%20%28CC0%29_0.mp3', 'House nhiệt đới kiểu tiệc biển. Hợp du lịch, đồ uống.', ['house', 'biển', 'tiệc']),
  cc0('tap-trung', 'chill-lofi', 'Chill Lofi', 'omfgdude', 'chill-lofi-inspired', 'ChillLofiR_0.mp3', 'Lofi piano và trống nhẹ. Hợp kiến thức, hướng dẫn.', ['lofi', 'piano', 'nhẹ']),
  cc0('tap-trung', 'mocha-frapp', 'Mocha Frapp', 'Alex McCulloch (Pro Sensory)', 'mocha-frapp', 'mocha_frapp_2.mp3', 'Jazz chill đều nhịp, ít gây chú ý. Hợp lời nói dài.', ['jazz', 'chill']),
  cc0('tap-trung', 'midnight-cruiser', 'Midnight Cruiser', 'Zane Little Music', 'midnight-cruiser', 'midnight_cruiser_0.mp3', 'Jazz funk fusion mượt, nhịp đều. Hợp tài chính, công nghệ.', ['jazz', 'funk', 'mượt']),
  cc0('tap-trung', 'red-moon', 'Red Moon', 'Alex McCulloch (Pro Sensory)', 'red-moon', 'red_moon_0.mp3', 'Pop jazz chill, nền êm. Hợp bài giảng ngắn.', ['jazz', 'pop', 'chill']),
  cc0('hoi-hop', 'i-swear-i-saw-it', 'I Swear I Saw It', 'yd', 'i-swear-i-saw-it-background-track', 'IswearIsawit_0.ogg', 'Nền tối bí ẩn kiểu không gian, dài khoảng 3,5 phút.', ['bí ẩn', 'tối', 'ambient']),
  cc0('hoi-hop', 'energetic-electro', 'Energetic Electro Tune', 'TinyWorlds', 'energetic-electro-tune', 'mixdown.ogg', 'Điện tử căng, có kịch tính. Hợp tiết lộ kết quả.', ['căng', 'điện tử', 'kịch tính']),
  cc0('hoi-hop', 'dark-forest', 'Dark Forest Theme', 'The Cynic Project (cynicmusic)', 'dark-forest-theme', 'GameMusic_ForestTheme_24_0.mp3', 'Guitar và dây u ám, gợi cảm giác rình rập.', ['u ám', 'guitar', 'dây']),
  cc0('hoi-hop', 'spacelife-14', 'Spacelife #14', 'yd', 'spacelife-14', 'spacelifeNo14.ogg', 'Ambient không gian, lơ lửng và hơi bất an.', ['không gian', 'ambient']),
  cc0('suy-tu', 'end-of-hope', 'At the End of Hope', 'Emma_MA', 'at-the-end-of-hope', 'at%20the%20end%20of%20hope_0.mp3', 'Piano điện buồn, chậm. Hợp tâm sự, bài học.', ['piano', 'buồn', 'chậm']),
  cc0('suy-tu', 'next-to-you', 'Next to You', 'Joth', 'next-to-you', 'Next%20to%20You.mp3', 'Giai điệu giàu cảm xúc, nhẹ nhàng.', ['cảm xúc', 'piano']),
  cc0('suy-tu', 'all-into-harmony', 'All into Harmony', 'Alex McCulloch (Pro Sensory)', 'all-into-harmony', 'all_in_to_harmony_0.mp3', 'Jazz êm, giàu cảm xúc. Hợp câu chuyện cá nhân.', ['jazz', 'cảm xúc']),
  cc0('suy-tu', 'sirens-in-darkness', 'Sirens in Darkness', 'The Cynic Project (cynicmusic)', 'sirens-in-darkness', '012_Sirens_in_Darkness_0.mp3', 'Pad ấm và piano, huyền ảo, trầm tư.', ['pad', 'piano', 'huyền ảo']),
  cc0('binh-yen', 'underwater', 'Underwater Theme', 'Cleyton Kauffman', 'underwater-theme', 'Cleyton%20RX%20-%20Underwater_0.mp3', 'Chuông, sáo và arpeggio dưới nước, êm và mở.', ['chuông', 'sáo', 'ambient']),
  cc0('binh-yen', 'etirwer', 'Etirwer', 'Kistol', 'etirwer', 'Etirwer%20%28Looped%29_0.ogg', 'Guitar nylon mộc, lặp liền mạch. Rất êm.', ['guitar', 'mộc', 'lặp']),
  cc0('binh-yen', 'snowfall', 'Snowfall', 'Kistol', 'snowfall', 'Snowfall%20%28Looped%20ver.%29_0.ogg', 'Piano valse nhẹ, bản lặp liền mạch.', ['piano', 'valse', 'lặp']),
  cc0('binh-yen', 'balance', 'Balance', 'Komiku (Loyalty Freak Music)', 'balance-0', 'Komiku%20-%20It%27s%20time%20for%20adventure%20vol%202%20-%2001%20Balance_0.mp3', 'Guitar mộc điềm tĩnh, nhịp chậm.', ['guitar', 'mộc', 'điềm tĩnh']),
];
