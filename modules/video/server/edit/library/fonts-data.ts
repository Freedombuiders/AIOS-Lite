// Curated Google Fonts families for the starter pack. Every family was checked against
// github.com/google/fonts (ofl/<dir>/METADATA.pb): licence OFL and `subsets: "vietnamese"`.
// seed.ts re-checks both at download time and skips a family that no longer qualifies.

export type FontCategory = 'sans' | 'serif' | 'display' | 'handwriting' | 'mono';

export interface CuratedFont {
  family: string;
  category: FontCategory;
  /** One Vietnamese line: when to use it. */
  note: string;
}

const f = (family: string, category: FontCategory, note: string): CuratedFont => ({ family, category, note });

export const CURATED_FONTS: readonly CuratedFont[] = [
  // The 22 families named in docs/plans/video-studio-assets.md §1.
  f('Phudu', 'display', 'Chữ đậm, vui, do người Việt thiết kế. Hợp tiêu đề bán hàng và ẩm thực.'),
  f('Dancing Script', 'handwriting', 'Chữ nối mềm. Hợp thời trang và làm đẹp.'),
  f('Alfa Slab One', 'display', 'Chân vuông rất đậm. Hợp tiêu đề gây chú ý và poster.'),
  f('Be Vietnam Pro', 'sans', 'Chữ không chân đa dụng, thiết kế riêng cho tiếng Việt.'),
  f('Lora', 'serif', 'Có chân, dễ đọc. Hợp bài giảng và nội dung kể chuyện.'),
  f('Anton', 'display', 'Cao, đậm, gọn. Hợp tiêu đề in hoa gắt.'),
  f('Barlow Condensed', 'sans', 'Hẹp, thể thao, nhiều độ đậm.'),
  f('Baloo 2', 'display', 'Tròn, thân thiện. Hợp ẩm thực và nội dung trẻ.'),
  f('Bungee', 'display', 'Đậm, vui, kiểu biển hiệu. Hợp hài và giải trí.'),
  f('Playfair Display', 'serif', 'Có chân, sang. Hợp bất động sản, điện ảnh, bài giảng.'),
  f('Oswald', 'sans', 'Hẹp, báo chí. Hợp bản tin và tiêu đề dài.'),
  f('Lexend', 'sans', 'Dễ đọc, khoảng cách rộng. Hợp hướng dẫn và tâm sự.'),
  f('Merriweather', 'serif', 'Có chân to, đọc rõ trên màn hình nhỏ. Hợp phụ đề dài.'),
  f('Space Grotesk', 'sans', 'Hình học, hơi lạ. Hợp công nghệ và startup.'),
  f('Manrope', 'sans', 'Hiện đại, gọn. Hợp phụ đề và tiêu đề công nghệ.'),
  f('Exo 2', 'sans', 'Dáng khoa học viễn tưởng. Hợp game và công nghệ.'),
  f('Fjalla One', 'sans', 'Hẹp, đậm, báo chí. Hợp tiêu đề ngắn.'),
  f('Raleway', 'sans', 'Thanh lịch, nhiều độ đậm. Hợp thời trang và làm đẹp.'),
  f('Quicksand', 'sans', 'Mảnh, tròn. Hợp làm đẹp và đời sống.'),
  f('Aleo', 'serif', 'Chân phiến, hiện đại. Hợp tiêu đề kiến thức.'),
  f('Archivo', 'sans', 'Không chân chắc, nhiều độ rộng. Hợp tiêu đề và phụ đề.'),
  f('Montserrat', 'sans', 'Hình học, chắc chắn. Hợp tiêu đề bán hàng và sự kiện.'),
  // The other families of the phase-0 catalog.
  f('Inter', 'sans', 'Giao diện sạch, dùng cho phụ đề và chú thích.'),
  f('Pacifico', 'handwriting', 'Chữ viết cọ vui. Hợp vlog.'),
  f('Nunito', 'sans', 'Tròn nhẹ, dễ đọc. Hợp phụ đề thân thiện.'),
  f('Roboto Mono', 'mono', 'Cách đều ký tự. Hợp code và lệnh.'),
  f('Saira Condensed', 'sans', 'Hẹp, công nghệ. Hợp AI và game.'),
  // Caption and display faces with Vietnamese glyphs.
  f('Roboto', 'sans', 'Quen mắt, rất dễ đọc. Hợp phụ đề mặc định.'),
  f('Open Sans', 'sans', 'Trung tính, dễ đọc. Hợp phụ đề và chú thích.'),
  f('Noto Sans', 'sans', 'Phủ ký tự rộng, dấu tiếng Việt chuẩn.'),
  f('Noto Serif', 'serif', 'Có chân, dấu tiếng Việt chuẩn. Hợp bài giảng.'),
  f('Josefin Sans', 'sans', 'Mảnh, dáng cổ điển hình học. Hợp thời trang.'),
  f('Lobster', 'display', 'Chữ nối đậm kiểu cũ. Hợp quán cà phê, ẩm thực.'),
  f('Sriracha', 'handwriting', 'Viết tay thân thiện, nét dày. Hợp vlog.'),
  f('Patrick Hand', 'handwriting', 'Viết tay gọn, dễ đọc. Hợp ghi chú trên video.'),
  f('Itim', 'handwriting', 'Viết tay tròn, vui. Hợp nội dung gần gũi.'),
  f('Bangers', 'display', 'Kiểu truyện tranh, đậm, nghiêng. Hợp hài và giải trí.'),
  f('Black Ops One', 'display', 'Kiểu quân sự, nặng. Hợp game và hành động.'),
  f('Barlow', 'sans', 'Gọn, hơi tròn góc. Hợp phụ đề và tiêu đề.'),
  f('Signika', 'sans', 'Rõ nét, thân thiện. Hợp biển chỉ dẫn và phụ đề.'),
  f('Work Sans', 'sans', 'Trung tính, hợp màn hình. Hợp phụ đề thương mại.'),
  f('Plus Jakarta Sans', 'sans', 'Hiện đại, mềm. Hợp thương hiệu và tiêu đề.'),
  f('Bricolage Grotesque', 'sans', 'Cá tính, nét dày mỏng lạ. Hợp tiêu đề sáng tạo.'),
  f('Roboto Condensed', 'sans', 'Hẹp, gọn. Hợp phụ đề dài trên khung dọc.'),
  f('Libre Franklin', 'sans', 'Kiểu báo chí cổ điển. Hợp bản tin.'),
  f('Comfortaa', 'display', 'Tròn, nhẹ. Hợp nội dung trẻ trung, công nghệ nhẹ.'),
  f('Cormorant Garamond', 'serif', 'Có chân thanh mảnh, sang. Hợp điện ảnh và thời trang.'),
  f('EB Garamond', 'serif', 'Có chân cổ điển. Hợp trích dẫn và sách.'),
  f('Yeseva One', 'display', 'Có chân đậm, nữ tính. Hợp làm đẹp và cưới.'),
  f('Dosis', 'sans', 'Hẹp, tròn, mảnh. Hợp tiêu đề nhẹ.'),
  f('Unbounded', 'sans', 'Rộng, tròn, tương lai. Hợp công nghệ và crypto.'),
  f('Bevan', 'serif', 'Chân phiến rất đậm. Hợp tiêu đề bán hàng.'),
  f('Big Shoulders Display', 'display', 'Hẹp, đậm, công nghiệp. Hợp thể thao.'),
  f('League Gothic', 'sans', 'Rất hẹp, cao, kiểu poster. Hợp tiêu đề in hoa.'),
  f('Paytone One', 'sans', 'Đậm, tròn, vui. Hợp quảng cáo.'),
  f('Space Mono', 'mono', 'Cách đều ký tự, hơi lạ. Hợp code và số liệu.'),
  f('JetBrains Mono', 'mono', 'Cách đều ký tự, dễ đọc. Hợp code.'),
  f('Charm', 'handwriting', 'Viết tay thanh. Hợp thiệp và tên người.'),
  f('Pangolin', 'handwriting', 'Viết tay tròn, dễ đọc. Hợp phụ đề thân mật.'),
  f('Amatic SC', 'handwriting', 'Chữ hoa mảnh vẽ tay. Hợp tiêu đề nhẹ nhàng.'),
] as const;

export const fontSlug = (family: string): string => family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Directory name of a family inside github.com/google/fonts/ofl/. */
export const fontRepoDir = (family: string): string => family.toLowerCase().replace(/[^a-z0-9]/g, '');

export const CATEGORY_LABEL: Record<FontCategory, string> = {
  sans: 'không chân',
  serif: 'có chân',
  display: 'tiêu đề',
  handwriting: 'viết tay',
  mono: 'cách đều',
};
