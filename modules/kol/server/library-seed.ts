/**
 * Builtin attribute library: Vietnamese names and groups for the owner, precise
 * English prompt fragments for the model. Fragments avoid pronouns so they fit
 * any persona; the composer wraps them ("Expression: …", "REPLACE the clothing
 * completely with …").
 *
 * Ids are stable ('b-<kind>-<slug>'): the seed inserts missing ids, so new
 * builtins appear after an update. Changed or retired builtins are listed in
 * REVISED_BUILTINS / RETIRED_BUILTINS with their old text; the owner's edits
 * are never overwritten.
 */

import type { LibraryGender, LibraryKind } from './types.js';

export interface SeedItem {
  id: string;
  kind: LibraryKind;
  group: string;
  name: string;
  prompt: string;
  tags: string[];
  /** Who it suits; 'all' when left out. Code-owned for builtins: the seed keeps it in sync. */
  gender?: LibraryGender;
}

type Row = [slug: string, name: string, prompt: string, tags?: string[]];

const PREFIX: Record<LibraryKind, string> = {
  expression: 'b-expr', hair: 'b-hair', outfit: 'b-outfit', scene: 'b-scene',
  pose: 'b-pose', look: 'b-look', effect: 'b-effect', camera: 'b-camera',
};

function group(kind: LibraryKind, groupName: string, rows: Row[], gender: LibraryGender = 'all'): SeedItem[] {
  return rows.map(([slug, name, prompt, tags]) => ({ id: `${PREFIX[kind]}-${slug}`, kind, group: groupName, name, prompt, tags: tags ?? [], gender }));
}

/** Marks some items of a list as suiting one gender only (by slug). */
function only(items: SeedItem[], gender: LibraryGender, slugs: string[]): SeedItem[] {
  const ids = new Set(slugs.map((sl) => `${PREFIX[items[0]?.kind ?? 'outfit']}-${sl}`));
  return items.map((i) => (ids.has(i.id) ? { ...i, gender } : i));
}

// ── Expressions (≥ 90) ───────────────────────────────────────────────

const EXPRESSIONS: SeedItem[] = [
  ...group('expression', 'Cử chỉ & phản ứng', [
    ['tongue-out', 'Lè lưỡi tinh nghịch', 'playfully sticking the tongue out, eyes slightly squinted with mischief'],
    ['wink', 'Nháy mắt', 'winking one eye at the camera with a sly half smile'],
    ['peace-sign', 'Giơ tay chữ V', 'making a peace sign with one hand next to the face, cheerful open smile'],
    ['finger-heart', 'Bắn tim bằng ngón tay', 'making a Korean finger heart with thumb and index finger crossed, sweet smile'],
    ['hand-heart', 'Tạo hình trái tim bằng hai tay', 'forming a heart shape with both hands in front of the chest, warm smile'],
    ['thumbs-up', 'Giơ ngón cái', 'giving a thumbs up toward the camera with a confident grin'],
    ['facepalm', 'Ôm trán bất lực', 'facepalming with one hand over the forehead, exasperated but amused'],
    ['shh', 'Suỵt (ngón tay lên môi)', 'index finger pressed to the lips in a shushing gesture, playful eyes'],
    ['blow-kiss', 'Hôn gió', 'blowing a kiss toward the camera, lips puckered, palm near the mouth'],
    ['pout', 'Phụng phịu', 'pouting with pushed-out lips and slightly furrowed brows, cute sulky look'],
    ['cheek-puff', 'Phồng má', 'puffing out both cheeks playfully, eyes wide'],
    ['hand-over-mouth', 'Che miệng ngạc nhiên', 'covering the mouth with one hand in surprise, eyes wide open'],
    ['eye-roll', 'Đảo mắt', 'rolling the eyes upward with a teasing smirk'],
    ['shrug', 'Nhún vai', 'shrugging with both palms turned up and a puzzled half smile'],
    ['ok-sign', 'Ra dấu OK', 'making an OK sign with one hand beside the face, satisfied smile'],
    ['salute', 'Chào kiểu nhà binh vui nhộn', 'giving a playful two-finger salute from the temple, grinning'],
    ['clap-laugh', 'Vỗ tay cười lớn', 'clapping both hands while laughing, head tilted back slightly'],
    ['cringe', 'Nhăn mặt ái ngại', 'cringing with clenched teeth and squinted eyes, awkward embarrassed expression'],
    ['chin-bored', 'Chống cằm chán nản', 'chin resting on one hand, bored half-lidded eyes'],
    ['nose-scrunch', 'Nhăn mũi đáng yêu', 'scrunching the nose cutely with a small grin'],
  ]),
  ...group('expression', 'Trung tính & suy nghĩ', [
    ['neutral-soft', 'Trung tính dịu', 'relaxed neutral expression, lips gently closed, calm soft gaze at the camera'],
    ['serious', 'Nghiêm túc', 'serious composed expression, steady direct eye contact, lips closed'],
    ['thinking-chin', 'Suy nghĩ (tay chạm cằm)', 'thoughtful expression with fingertips touching the chin, eyes looking up and to the side'],
    ['daydream', 'Mơ màng', 'dreamy faraway look, eyes unfocused into the distance, faint smile'],
    ['curious-tilt', 'Nghiêng đầu tò mò', 'head tilted slightly with a curious, inquisitive look and raised eyebrows'],
    ['skeptical', 'Hoài nghi (nhướng một bên mày)', 'one eyebrow raised skeptically, lips pressed to one side'],
    ['focused', 'Tập trung', 'focused concentrated expression, slightly narrowed eyes, relaxed lips'],
    ['eyes-closed-calm', 'Nhắm mắt thư giãn', 'eyes gently closed, peaceful serene expression, relaxed brow'],
    ['gaze-away', 'Nhìn xa xăm', 'looking away from the camera into the distance, soft neutral expression'],
    ['side-glance', 'Liếc mắt', 'side glance toward the camera without turning the head, subtle knowing look'],
    ['pensive', 'Trầm tư', 'pensive reflective mood, gaze lowered, lips slightly parted'],
    ['confident-calm', 'Tự tin điềm tĩnh', 'confident calm expression, chin slightly raised, relaxed jaw, steady eyes'],
    ['lip-bite-thinking', 'Cắn môi suy nghĩ', 'lightly biting the lower lip while thinking, eyes looking down'],
    ['sleepy', 'Ngái ngủ', 'sleepy drowsy look, heavy eyelids, just finishing a small yawn'],
    ['reading', 'Đọc chăm chú', 'absorbed in reading, eyes cast downward, calm concentration'],
    ['mysterious', 'Bí ẩn', 'mysterious subtle expression, slight smirk, half-lidded intense eyes'],
    ['listening', 'Lắng nghe', 'attentive listening expression, slight nod, gentle eye contact'],
    ['deadpan', 'Mặt lạnh hài hước', 'deadpan expressionless face, flat eyebrows, comedic stillness'],
  ]),
  ...group('expression', 'Xã hội & giao tiếp', [
    ['warm-smile', 'Cười ấm áp', 'warm genuine smile that reaches the eyes, slight crow’s feet, relaxed face'],
    ['big-laugh', 'Cười to sảng khoái', 'laughing openly with mouth open and eyes crinkled, natural candid joy'],
    ['shy-smile', 'Cười e thẹn', 'shy closed-lip smile, eyes glancing down, slight blush on the cheeks'],
    ['smirk', 'Cười nửa miệng', 'confident smirk with one corner of the mouth raised'],
    ['flirty', 'Cười tình', 'flirty playful look over the shoulder, soft smile, eyes engaging the camera'],
    ['wave', 'Vẫy tay chào', 'waving hello at the camera with an open friendly smile'],
    ['polite-bow', 'Cúi chào lễ phép', 'slight polite bow with hands together, gracious smile'],
    ['mid-sentence', 'Đang nói chuyện', 'caught mid-sentence while talking, mouth slightly open, animated eyebrows, natural candid moment'],
    ['explaining', 'Giải thích bằng tay', 'explaining something with expressive open-hand gestures, engaged expression'],
    ['point-camera', 'Chỉ vào ống kính', 'pointing at the camera with a confident playful grin'],
    ['point-aside', 'Chỉ sang bên', 'pointing to the side as if presenting something, enthusiastic smile'],
    ['whisper', 'Thì thầm bí mật', 'leaning toward the camera with a hand beside the mouth as if whispering a secret'],
    ['cheers', 'Nâng ly chúc mừng', 'raising a glass in a cheers toast, celebratory smile'],
    ['empathetic', 'Đồng cảm', 'empathetic caring expression, soft eyes, slight head tilt, gentle closed smile'],
    ['proud', 'Tự hào', 'proud beaming smile, chest slightly lifted, sparkling eyes'],
    ['teasing', 'Trêu chọc', 'teasing grin with narrowed playful eyes'],
    ['grateful', 'Biết ơn (tay đặt lên ngực)', 'grateful expression with one hand on the heart, soft smile'],
    ['inviting', 'Mời gọi', 'beckoning the viewer with one hand, inviting smile'],
  ]),
  ...group('expression', 'Cảm xúc mạnh', [
    ['ecstatic', 'Phấn khích tột độ', 'ecstatic joy, wide open-mouth smile, bright eyes, both arms raised in excitement'],
    ['shocked', 'Sốc', 'shocked expression, jaw dropped, eyes wide, eyebrows raised high'],
    ['scared', 'Sợ hãi', 'frightened expression, eyes wide, hands raised near the face, tense shoulders'],
    ['angry', 'Tức giận', 'angry expression, furrowed brows, tight lips, intense glare'],
    ['comic-fury', 'Giận dỗi kiểu hài', 'comically furious face, puffed cheeks, clenched fists, exaggerated frown'],
    ['crying', 'Khóc rơi nước mắt', 'crying with real tears rolling down the cheeks, trembling lips, reddened eyes'],
    ['sad', 'Buồn', 'sad downcast expression, drooping eyelids, slight frown'],
    ['heartbroken', 'Thất tình', 'heartbroken expression, glossy eyes holding back tears, one hand on the chest'],
    ['disgust', 'Ghê tởm', 'disgusted expression, wrinkled nose, upper lip raised, leaning back'],
    ['amazed', 'Há hốc kinh ngạc', 'amazed awe, mouth open, both hands on the cheeks, sparkling eyes'],
    ['scream-joy', 'Hét lên vui sướng', 'screaming with excitement, mouth wide open, eyes squeezed shut, fists pumped'],
    ['nervous', 'Lo lắng', 'nervous anxious expression, biting a fingernail, eyes darting sideways'],
    ['blushing', 'Ngượng đỏ mặt', 'deeply embarrassed, flushed red cheeks, hands half covering the face, peeking through the fingers'],
    ['relieved', 'Nhẹ nhõm', 'relieved exhale, eyes closed, hand on the chest, small smile'],
    ['determined', 'Quyết tâm', 'fierce determined expression, set jaw, focused eyes, clenched fist'],
    ['exhausted', 'Kiệt sức', 'exhausted expression, slumped shoulders, half-closed eyes'],
    ['happy-tears', 'Khóc vì hạnh phúc', 'happy tears, smiling while wiping a tear from one eye'],
    ['laugh-tears', 'Cười chảy nước mắt', 'laughing so hard the eyes water, holding the stomach'],
    ['panicked', 'Hoảng loạn', 'panicked expression, both hands on the head, eyes wide, mouth open'],
  ]),
  ...group('expression', 'Selfie & camera', [
    ['selfie-smile', 'Selfie cười tươi', 'smiling into the front camera of a phone held at arm’s length, slight high angle'],
    ['selfie-duckface', 'Selfie môi chu', 'selfie with a playful duck-face pout, phone held slightly above eye level'],
    ['selfie-peace', 'Selfie chữ V', 'selfie making a peace sign beside the face, big smile'],
    ['selfie-wink-tongue', 'Selfie nháy mắt lè lưỡi', 'selfie winking with the tongue slightly out, playful energy'],
    ['mirror-cool', 'Selfie gương mặt lạnh', 'mirror selfie with the phone covering part of the face, cool neutral expression'],
    ['looking-at-phone', 'Nhìn điện thoại', 'looking down at a phone screen, unaware of the camera, soft natural expression'],
    ['caught-candid', 'Bị chụp lén', 'caught candidly mid-laugh, glancing toward the camera in surprise'],
    ['over-shoulder', 'Ngoái nhìn qua vai', 'looking back over the shoulder at the camera, subtle smile'],
    ['eyes-close-up', 'Cận mắt nhìn thẳng', 'extreme close-up with intense direct eye contact into the lens'],
    ['hair-flip', 'Hất tóc', 'mid hair flip, hair in motion, confident smile'],
    ['hide-smile', 'Che miệng cười', 'half hiding a smile behind one hand, eyes smiling at the camera'],
    ['kiss-lens', 'Hôn ống kính', 'leaning toward the lens with puckered lips, playful'],
    ['goofy', 'Selfie nhắng nhít', 'goofy fun selfie face, scrunched nose, tongue slightly out, crossed eyes'],
    ['peek-in', 'Ló mặt vào khung hình', 'peeking into the frame from one side, curious playful grin'],
    ['glance-up', 'Ngẩng lên từ điện thoại', 'glancing up from a phone toward the camera, gentle surprised smile'],
    ['vlog', 'Nói chuyện kiểu vlog', 'talking to the camera like a vlogger, animated expression, phone at arm’s length'],
    ['sunglasses-down', 'Kéo kính râm xuống', 'lowering sunglasses with one finger and looking over them at the camera'],
    ['chin-up', 'Ngẩng cằm tự tin', 'chin up, confident look down into the lens, slight smirk'],
    ['straw-bite', 'Cắn ống hút', 'playfully biting a drinking straw, eyes on the camera'],
  ]),
];

// ── Hair (≥ 30) ──────────────────────────────────────────────────────

const HAIR_WOMEN_AND_ALL: SeedItem[] = [
  ...group('hair', 'Tóc dài', [
    ['long-straight-black', 'Dài thẳng đen óng', 'long straight glossy jet-black hair past the shoulders, center part'],
    ['long-beach-waves', 'Dài uốn sóng lơi', 'long hair with loose soft beach waves and natural volume'],
    ['long-curly', 'Dài xoăn bồng', 'long voluminous curly hair with defined ringlets'],
    ['long-side-part', 'Dài rẽ ngôi lệch', 'long sleek hair with a deep side part swept over one shoulder'],
    ['long-air-bangs', 'Dài mái thưa', 'long straight hair with soft see-through wispy bangs (Korean air bangs)'],
    ['long-wet-look', 'Dài kiểu wet-look', 'long slicked-back wet-look hair'],
    ['long-half-up', 'Dài buộc nửa đầu', 'long hair in a half-up half-down style held with a small clip'],
    ['long-layered', 'Dài tỉa layer', 'long layered hair with face-framing layers and blowout volume'],
  ]),
  ...group('hair', 'Tóc ngắn & ngang vai', [
    ['bob-sleek', 'Bob thẳng', 'sleek chin-length bob with blunt ends'],
    ['bob-bangs', 'Bob mái bằng', 'chin-length bob with straight blunt bangs'],
    ['lob-waves', 'Ngang vai uốn nhẹ', 'shoulder-length lob with soft waves'],
    ['pixie', 'Pixie cá tính', 'short textured pixie cut'],
    ['wolf-cut', 'Wolf cut', 'shaggy wolf cut with choppy layers and curtain bangs'],
    ['curtain-bangs', 'Ngang vai mái rèm', 'shoulder-length hair with curtain bangs parted in the middle'],
    ['short-curly', 'Ngắn xoăn', 'short curly hair with natural texture'],
    ['crop', 'Tóc tém', 'very short cropped hair with neat sides'],
  ]),
  ...group('hair', 'Tóc buộc & búi', [
    ['high-ponytail', 'Đuôi ngựa cao', 'sleek high ponytail, hair pulled back tightly'],
    ['low-ponytail', 'Đuôi ngựa thấp', 'low loose ponytail with a few face-framing strands'],
    ['messy-bun', 'Búi rối', 'messy top bun with loose strands framing the face'],
    ['sleek-bun', 'Búi thấp gọn', 'sleek low chignon bun, polished'],
    ['space-buns', 'Hai búi trên đầu', 'two playful space buns on top of the head'],
    ['pigtail-braids', 'Tết hai bên', 'two long braided pigtails'],
    ['french-braid', 'Tết kiểu Pháp', 'a single French braid down the back'],
    ['claw-clip', 'Kẹp càng cua', 'hair twisted up and held with a claw clip, casual'],
    ['scarf-ponytail', 'Đuôi ngựa buộc khăn', 'ponytail tied with a silk scarf'],
  ]),
  ...group('hair', 'Kiểu đặc biệt', [
    ['hime-cut', 'Hime cut', 'Japanese hime cut with straight sidelocks and blunt bangs'],
    ['vintage-curls', 'Xoăn cổ điển', '1950s vintage glamour curls, side-swept'],
    ['braided-crown', 'Tết vương miện', 'braided crown hairstyle wrapping around the head'],
    ['ao-dai-updo', 'Búi truyền thống (áo dài)', 'elegant traditional Vietnamese low updo with a simple hairpin, suited to an áo dài'],
    ['windblown', 'Tóc bay trong gió', 'hair blowing naturally in the wind'],
    ['bedhead', 'Tóc rối mới ngủ dậy', 'tousled just-woke-up bedhead hair'],
  ]),
  ...group('hair', 'Màu tóc', [
    ['color-chestnut', 'Nâu hạt dẻ', 'hair dyed a rich chestnut brown'],
    ['color-ash-brown', 'Nâu khói', 'hair dyed a cool ash brown'],
    ['color-honey-blonde', 'Vàng mật ong', 'hair dyed a warm honey blonde with slightly darker roots'],
    ['color-burgundy', 'Đỏ rượu vang', 'hair dyed a deep burgundy wine red'],
    ['color-pastel-pink', 'Hồng pastel', 'hair dyed a soft pastel pink'],
    ['color-balayage', 'Balayage', 'brunette hair with caramel balayage highlights'],
  ]),
];

/** Women's styles; the rest (wolf cut, short curls, crop, windblown, bedhead, colours) suit anyone. */
const HAIR: SeedItem[] = [
  ...HAIR_WOMEN_AND_ALL.map((i) => ({
    ...i,
    gender: (['b-hair-wolf-cut', 'b-hair-short-curly', 'b-hair-crop', 'b-hair-windblown', 'b-hair-bedhead'].includes(i.id) || i.id.startsWith('b-hair-color-')) ? 'all' as const : 'female' as const,
  })),
  ...group('hair', 'Tóc nam', [
    ['men-side-part', 'Rẽ ngôi lệch gọn', 'a classic short side-part haircut, neatly combed, tapered sides'],
    ['men-undercut', 'Undercut vuốt ngược', 'an undercut with a longer top slicked back and short faded sides'],
    ['men-quiff', 'Quiff bồng', 'a textured quiff with volume at the front and short tapered sides'],
    ['men-two-block', 'Two-block Hàn Quốc', 'a Korean two-block cut with a soft fringe falling over the forehead'],
    ['men-curtain', 'Mái rẽ đôi (curtain)', 'a medium-length men\'s curtain hairstyle with a middle part'],
    ['men-crew-cut', 'Crew cut', 'a short crew cut, slightly longer on top, neat and clean'],
    ['men-buzz', 'Đầu đinh', 'a very short even buzz cut'],
    ['men-textured-crop', 'Textured crop', 'a textured French crop with a short blunt fringe and a skin fade'],
    ['men-slick-back', 'Vuốt ngược bóng', 'medium-length hair slicked back with a glossy finish'],
    ['men-pompadour', 'Pompadour', 'a classic pompadour with height at the front and short sides'],
    ['men-man-bun', 'Man bun', 'shoulder-length hair tied back in a man bun'],
    ['men-messy-fringe', 'Mái rối tự nhiên', 'a messy textured fringe, natural and casual'],
    ['men-salt-pepper', 'Muối tiêu điểm bạc', 'short neat hair with natural salt-and-pepper grey at the temples'],
  ], 'male'),
];

// ── Outfits (≥ 40) ───────────────────────────────────────────────────

const OUTFITS_WOMEN: SeedItem[] = [
  ...group('outfit', 'Truyền thống Việt', [
    ['ao-dai-white', 'Áo dài trắng nữ sinh', 'a traditional white Vietnamese áo dài: long fitted silk tunic with a high mandarin collar and high side slits, worn over loose white silk trousers'],
    ['ao-dai-red-gold', 'Áo dài đỏ thêu vàng (Tết)', 'a red silk Vietnamese áo dài with gold embroidered motifs and a mandarin collar, worn over white silk trousers, festive Tết look'],
    ['ao-dai-pastel-floral', 'Áo dài pastel hoa nhí', 'a pastel pink Vietnamese áo dài with delicate printed florals, fitted tunic with side slits over matching trousers'],
    ['ao-dai-modern', 'Áo dài cách tân', 'a modern cách tân áo dài with a knee-length tunic in soft pastel silk, paired with wide-leg trousers'],
    ['ao-ba-ba', 'Áo bà ba', 'a traditional Southern Vietnamese áo bà ba: loose button-front silk blouse with matching black silk trousers'],
    ['ao-dai-non-la', 'Áo dài + nón lá', 'a flowing white áo dài with a conical nón lá palm-leaf hat held in one hand'],
    ['ao-tu-than', 'Áo tứ thân', 'a Northern Vietnamese áo tứ thân four-panel dress over a yếm bodice with a silk sash, traditional festival style'],
    ['ao-nhat-binh', 'Áo Nhật Bình (cung đình Huế)', 'a Hue royal-court áo nhật bình: wide square-collared embroidered silk overcoat over a long pleated skirt'],
  ]),
  ...group('outfit', 'Hằng ngày & streetwear', [
    ['white-tee-jeans', 'Áo thun trắng + jeans', 'a plain fitted white crew-neck T-shirt tucked into high-waisted straight-leg blue jeans, white sneakers'],
    ['oversized-hoodie', 'Hoodie oversize', 'an oversized heather-grey hoodie with black bike shorts and chunky sneakers'],
    ['streetwear-cargo', 'Streetwear cargo', 'a cropped black tank top, baggy olive cargo pants, chunky sneakers and a small crossbody bag'],
    ['denim-jacket', 'Áo khoác jeans', 'a light-wash denim jacket over a white tank top with a black mini skirt'],
    ['floral-sundress', 'Váy hoa mùa hè', 'a flowy floral midi sundress with thin straps and a straw tote bag'],
    ['y2k', 'Phong cách Y2K', 'a Y2K outfit: fitted baby tee, low-rise flared jeans, tinted sunglasses and a small shoulder bag'],
    ['korean-casual', 'Casual kiểu Hàn', 'Korean casual style: cream knit cardigan over a white tee, pleated tennis skirt and loafers'],
    ['linen-set', 'Set linen', 'a beige linen button-up shirt with matching wide-leg linen trousers, relaxed fit'],
    ['leather-jacket', 'Áo da biker', 'a black leather biker jacket over a grey tee with black skinny jeans and ankle boots'],
    ['preppy-polo', 'Polo + chân váy tennis', 'a white polo shirt with a pleated tennis skirt and white sneakers, preppy look'],
  ]),
  ...group('outfit', 'Công sở', [
    ['blazer-suit', 'Vest công sở', 'a tailored beige blazer with matching straight trousers over a silk camisole, minimal gold jewelry'],
    ['white-shirt-pencil', 'Sơ mi trắng + chân váy bút chì', 'a crisp white button-up shirt tucked into a black high-waisted pencil skirt, pointed heels'],
    ['knit-trousers', 'Len mỏng công sở', 'a fine-knit black turtleneck with camel wide-leg trousers'],
    ['power-suit', 'Suit đen quyền lực', 'a sharp black double-breasted power suit with a black camisole underneath, sleek and elegant'],
    ['shirt-dress', 'Đầm sơ mi', 'a belted navy shirt dress, knee length, office-ready'],
  ]),
  ...group('outfit', 'Thể thao & gym', [
    ['gym-set', 'Đồ tập gym', 'a matching sage-green sports bra and high-waisted leggings set with training sneakers'],
    ['yoga', 'Đồ yoga', 'a soft neutral yoga set: fitted long-sleeve crop top and flared yoga pants, barefoot'],
    ['running', 'Đồ chạy bộ', 'a running outfit: lightweight tank top, running shorts, a cap and running shoes'],
    ['tennis', 'Đồ tennis', 'a white tennis dress with a visor and tennis shoes'],
    ['athleisure', 'Athleisure', 'a cropped zip-up track jacket with matching joggers and clean white sneakers'],
  ]),
  ...group('outfit', 'Đi biển (kín đáo)', [
    ['one-piece', 'Đồ bơi liền thân', 'an elegant black one-piece swimsuit with a sheer sarong tied at the waist, tasteful and non-revealing'],
    ['swim-coverup', 'Đồ bơi + áo choàng', 'a modest two-piece swimsuit covered by an open white linen beach shirt and a wide-brim straw hat, tasteful'],
    ['beach-maxi', 'Váy đi biển', 'a loose white cotton beach maxi dress with a straw hat and flat sandals'],
    ['resort-set', 'Set nghỉ dưỡng', 'a printed resort shirt and matching shorts set with sandals and sunglasses'],
  ]),
  ...group('outfit', 'Dự tiệc & dạ hội', [
    ['satin-gown', 'Đầm dạ hội satin', 'a floor-length champagne satin evening gown with a cowl neckline and elegant drape'],
    ['little-black-dress', 'Đầm đen dự tiệc', 'a classic little black dress, knee length and fitted, with strappy heels'],
    ['sequin-mini', 'Đầm sequin', 'a sparkling silver sequin mini dress for a party night'],
    ['velvet-gown', 'Đầm nhung thảm đỏ', 'a deep emerald velvet gown with a long train, red-carpet glamour'],
    ['pastel-cocktail', 'Đầm cocktail pastel', 'a pastel blue cocktail dress with soft puff sleeves'],
  ]),
  ...group('outfit', 'Mùa lạnh', [
    ['trench-coat', 'Áo măng tô', 'a camel trench coat over a cream knit sweater, dark jeans and ankle boots'],
    ['puffer', 'Áo phao', 'a cropped black puffer jacket with a knit beanie and a scarf'],
    ['cozy-knit', 'Áo len dày', 'a chunky oversized cream cable-knit sweater with a plaid skirt and knee-high boots'],
  ]),
  ...group('outfit', 'Ở nhà & ngủ', [
    ['silk-pajamas', 'Pyjama lụa', 'a matching champagne silk pajama set with contrast piping'],
    ['loungewear', 'Đồ mặc nhà', 'a soft grey ribbed lounge set with cozy socks'],
    ['oversized-shirt', 'Sơ mi oversize ở nhà', 'an oversized white button-up shirt worn loosely with shorts, relaxed at-home look'],
  ]),
];

const OUTFITS_MEN: SeedItem[] = [
  ...group('outfit', 'Truyền thống Việt', [
    ['men-ao-dai-navy', 'Áo dài nam gấm xanh than', 'a traditional Vietnamese men\'s áo dài in deep navy brocade silk with a mandarin collar, worn over white silk trousers'],
    ['men-ao-dai-red', 'Áo dài nam đỏ (Tết)', 'a red silk Vietnamese men\'s áo dài with subtle gold patterns and a mandarin collar over white trousers, festive Tết look'],
  ], 'male'),
  ...group('outfit', 'Hằng ngày & streetwear', [
    ['men-tee-jeans', 'Áo thun trắng + jeans', 'a plain white crew-neck T-shirt, slim dark indigo jeans and white leather sneakers'],
    ['men-polo-chinos', 'Polo + quần kaki', 'a navy knit polo shirt, beige slim chinos, brown leather loafers'],
    ['men-oversized-cargo', 'Streetwear cargo', 'an oversized black graphic-free T-shirt, olive cargo pants, chunky sneakers and a crossbody bag'],
    ['men-denim-jacket', 'Áo khoác jeans', 'a mid-wash denim jacket over a grey hoodie, black jeans and white sneakers'],
    ['men-flannel', 'Sơ mi flannel', 'an open red-and-black flannel shirt over a white T-shirt, light jeans and leather boots'],
    ['men-korean-casual', 'Casual kiểu Hàn', 'Korean men\'s casual style: a cream knit cardigan over a white tee, relaxed grey trousers and loafers'],
  ], 'male'),
  ...group('outfit', 'Công sở', [
    ['men-navy-suit', 'Suit xanh navy', 'a tailored navy two-piece suit, a crisp white shirt, a burgundy silk tie and brown oxford shoes'],
    ['men-shirt-trousers', 'Sơ mi + quần âu', 'a light-blue Oxford shirt tucked into charcoal tailored trousers with a black leather belt and black loafers'],
    ['men-smart-casual', 'Blazer + áo thun', 'an unstructured grey blazer over a black crew-neck T-shirt, black slim trousers and white sneakers'],
    ['men-turtleneck', 'Áo cổ lọ + blazer', 'a black fine-knit turtleneck under a camel wool blazer, dark trousers and Chelsea boots'],
  ], 'male'),
  ...group('outfit', 'Thể thao & gym', [
    ['men-gym', 'Đồ tập gym', 'a fitted black training T-shirt, grey training shorts and training shoes'],
    ['men-running', 'Đồ chạy bộ', 'a lightweight running T-shirt, running shorts, a cap and running shoes'],
    ['men-tennis', 'Đồ tennis', 'a white tennis polo, white shorts, white socks and court shoes'],
  ], 'male'),
  ...group('outfit', 'Đi biển (kín đáo)', [
    ['men-swim', 'Quần bơi + sơ mi linen', 'navy knee-length swim shorts with an open white linen shirt and sunglasses'],
  ], 'male'),
  ...group('outfit', 'Dự tiệc & dạ hội', [
    ['men-tuxedo', 'Tuxedo đen', 'a classic black tuxedo with satin lapels, a white dress shirt, a black bow tie and patent shoes'],
    ['men-velvet-blazer', 'Blazer nhung dự tiệc', 'a deep green velvet dinner jacket, a black shirt, black trousers and polished shoes'],
    ['men-black-suit', 'Suit đen + sơ mi đen', 'a sleek black suit over a black shirt with no tie, modern evening look'],
  ], 'male'),
  ...group('outfit', 'Mùa lạnh', [
    ['men-overcoat', 'Măng tô len', 'a charcoal wool overcoat over a navy knit sweater, dark trousers and leather boots, a grey scarf'],
    ['men-puffer', 'Áo phao', 'a black hooded puffer jacket, dark jeans and boots, a knit beanie'],
  ], 'male'),
  ...group('outfit', 'Ở nhà & ngủ', [
    ['men-pajamas', 'Pyjama cotton', 'a navy cotton pajama set with white piping'],
    ['men-lounge', 'Đồ mặc nhà', 'a plain grey T-shirt and soft charcoal jogger pants, relaxed at home'],
  ], 'male'),
];

/** Women's outfits, a few that suit anyone (linen set, leather jacket, resort set, running, trench coat, lounge set), then men's. */
const OUTFITS: SeedItem[] = [
  ...OUTFITS_WOMEN.map((i) => ({
    ...i,
    gender: ['b-outfit-linen-set', 'b-outfit-leather-jacket', 'b-outfit-resort-set', 'b-outfit-running', 'b-outfit-trench-coat', 'b-outfit-loungewear'].includes(i.id) ? 'all' as const : 'female' as const,
  })),
  ...OUTFITS_MEN,
];

// ── Scenes (≥ 40) ────────────────────────────────────────────────────

const SCENES: SeedItem[] = [
  ...group('scene', 'Hà Nội', [
    ['hanoi-old-quarter', 'Phố cổ Hà Nội', 'a narrow street in the Hanoi Old Quarter with yellow French-colonial shophouses, tangled power lines, parked motorbikes and hanging lanterns'],
    ['hanoi-train-street', 'Phố đường tàu', 'Hanoi Train Street: a railway track running between tightly packed colourful houses and tiny cafés'],
    ['hoan-kiem', 'Hồ Gươm', 'the shore of Hoan Kiem Lake in Hanoi with the red Thê Húc bridge and willow trees, early morning light'],
    ['hanoi-autumn', 'Phố Hà Nội mùa thu', 'a tree-lined Hanoi street in autumn with fallen yellow leaves and a vendor bicycle loaded with flowers'],
    ['hanoi-opera', 'Nhà hát Lớn Hà Nội', 'in front of the yellow neoclassical Hanoi Opera House on a clear day'],
    ['van-mieu', 'Văn Miếu', 'the Temple of Literature courtyard in Hanoi with ancient gates, stone steles and bonsai trees'],
  ]),
  ...group('scene', 'Sài Gòn', [
    ['saigon-rooftop', 'Rooftop Sài Gòn', 'a stylish rooftop bar in Saigon at dusk overlooking the skyline with Landmark 81 in the distance, warm string lights'],
    ['saigon-street', 'Phố Sài Gòn', 'a busy Saigon street with motorbike traffic, street-food stalls and neon shop signs'],
    ['bui-vien', 'Phố đi bộ Bùi Viện', 'Bui Vien walking street in Saigon at night with colourful neon lights and crowds'],
    ['cafe-apartment', 'Chung cư cà phê Nguyễn Huệ', 'a balcony of the old café apartment building on Nguyen Hue walking street, Saigon'],
    ['saigon-cathedral', 'Nhà thờ Đức Bà', 'in front of the red-brick Saigon Notre-Dame Cathedral'],
    ['ben-thanh', 'Chợ Bến Thành', 'inside Ben Thanh Market with colourful stalls of fabrics and tropical fruit'],
  ]),
  ...group('scene', 'Đà Lạt & miền núi', [
    ['dalat-pines', 'Rừng thông Đà Lạt', 'a misty pine forest in Da Lat with soft morning fog'],
    ['dalat-flowers', 'Vườn hoa Đà Lạt', 'a flower garden in Da Lat with hydrangeas and a white wooden fence'],
    ['dalat-station', 'Ga Đà Lạt', 'the vintage Da Lat railway station with art-deco architecture and an old steam train'],
    ['sapa-terraces', 'Ruộng bậc thang Sa Pa', 'green rice terraces in the Sa Pa mountains with clouds rolling over the peaks'],
    ['ha-giang-pass', 'Đèo Mã Pí Lèng', 'a winding mountain road at Ma Pi Leng pass, Ha Giang, dramatic limestone cliffs'],
  ]),
  ...group('scene', 'Biển & đảo', [
    ['nha-trang-beach', 'Biển Nha Trang', 'a sandy beach in Nha Trang with turquoise water and palm trees'],
    ['phu-quoc-sunset', 'Hoàng hôn Phú Quốc', 'a Phu Quoc beach at sunset with golden light reflecting on the sea'],
    ['ha-long-bay', 'Vịnh Hạ Long', 'the deck of a boat in Ha Long Bay with emerald water and limestone karsts'],
    ['hoi-an-lanterns', 'Phố cổ Hội An', 'a Hoi An ancient-town street at night lit by colourful silk lanterns, yellow walls'],
    ['my-khe-sunrise', 'Biển Mỹ Khê bình minh', 'My Khe beach in Da Nang at sunrise, soft pastel sky, gentle waves'],
  ]),
  ...group('scene', 'Café & quán', [
    ['cozy-cafe', 'Quán café ấm cúng', 'a cozy café interior with wooden tables, warm pendant lights and plants'],
    ['minimal-cafe', 'Café tối giản', 'a minimalist white café with large windows, a concrete counter and natural daylight'],
    ['vintage-hanoi-cafe', 'Café vintage Hà Nội', 'a vintage Hanoi coffee shop with retro furniture, old radios and low plastic stools'],
    ['egg-coffee', 'Café trứng', 'a small table with Vietnamese egg coffee in a traditional Hanoi café'],
    ['street-food', 'Quán vỉa hè', 'a Vietnamese sidewalk food stall with low plastic stools and steaming bowls of phở'],
    ['book-cafe', 'Café sách', 'a book café with tall shelves full of books and warm reading lamps'],
  ]),
  ...group('scene', 'Studio', [
    ['studio-white', 'Studio phông trắng', 'a professional photo studio with a seamless white backdrop and soft even lighting'],
    ['studio-grey', 'Studio phông xám', 'a photo studio with a neutral mid-grey seamless backdrop'],
    ['studio-gel', 'Studio đèn màu', 'a studio with a colourful gel-lit backdrop in magenta and teal'],
    ['studio-beige', 'Studio be + đạo cụ', 'a warm beige studio set with minimalist props: a plinth, dried pampas grass and soft shadows'],
  ]),
  ...group('scene', 'Trong nhà', [
    ['bedroom-morning', 'Phòng ngủ buổi sáng', 'a bright bedroom in the morning with white linen bedding and sunlight through sheer curtains'],
    ['modern-apartment', 'Căn hộ hiện đại', 'a modern apartment living room with a sofa, plants and a city-view window'],
    ['kitchen', 'Bếp', 'a bright modern kitchen with marble counters and fresh ingredients'],
    ['gym', 'Phòng gym', 'a modern gym with dumbbell racks, mirrors and moody lighting'],
    ['hotel-suite', 'Khách sạn sang trọng', 'a luxury hotel suite with large windows, a velvet armchair and soft lamplight'],
    ['coworking', 'Văn phòng coworking', 'a stylish coworking office with laptops, plants and glass walls'],
  ]),
  ...group('scene', 'Quốc tế & khác', [
    ['seoul-seongsu', 'Phố Seoul', 'a trendy street in Seongsu-dong, Seoul, with red-brick buildings and boutique cafés'],
    ['tokyo-night', 'Tokyo về đêm', 'a Shibuya street in Tokyo at night with neon signs and rain-reflecting pavement'],
    ['paris-street', 'Phố Paris', 'a Parisian street with Haussmann buildings and a café terrace'],
    ['airport', 'Sân bay', 'an airport terminal with large windows and planes outside, travel vibe'],
    ['sunflower-field', 'Cánh đồng hướng dương', 'a sunflower field in golden afternoon light'],
    ['car-night', 'Trong xe ô tô ban đêm', 'inside a car at night with city-light bokeh through the window'],
  ]),
];

// ── Poses (≥ 20) ─────────────────────────────────────────────────────

const POSES: SeedItem[] = [
  ...group('pose', 'Đứng', [
    ['standing-front', 'Đứng thẳng nhìn ống kính', 'standing facing the camera, weight on one leg, relaxed arms'],
    ['hand-on-hip', 'Tay chống hông', 'standing with one hand on the hip, slight contrapposto'],
    ['lean-wall', 'Dựa tường', 'leaning casually against a wall, one foot propped up behind'],
    ['arms-crossed', 'Khoanh tay', 'standing with arms crossed, confident stance'],
    ['back-look', 'Quay lưng ngoái lại', 'back to the camera, head turned to look over the shoulder'],
    ['hands-pockets', 'Đút tay túi quần', 'standing relaxed with hands in the pockets'],
    ['three-quarter', 'Nghiêng 3/4', 'body turned three-quarters to the camera, face toward the lens'],
  ]),
  ...group('pose', 'Ngồi & nằm', [
    ['chair-legs-crossed', 'Ngồi ghế bắt chéo chân', 'sitting on a chair with legs crossed, hands resting on the knee'],
    ['floor-knees-up', 'Ngồi bệt ôm gối', 'sitting on the floor with knees up and arms wrapped around them'],
    ['steps', 'Ngồi bậc thềm', 'sitting on outdoor steps with elbows on the knees'],
    ['cafe-table', 'Ngồi bàn café', 'sitting at a café table, one hand holding a cup'],
    ['bed-lying', 'Nằm sấp trên giường', 'lying on the stomach on a bed, chin resting on the hands, feet up'],
    ['ledge', 'Ngồi mép lan can', 'sitting on a ledge with legs dangling'],
  ]),
  ...group('pose', 'Chuyển động', [
    ['walk-toward', 'Đi về phía máy', 'walking toward the camera mid-stride, natural movement'],
    ['walk-away-glance', 'Đi xa rồi ngoái lại', 'walking away and glancing back at the camera'],
    ['twirl', 'Xoay váy', 'twirling so the dress flares out, caught mid-spin'],
    ['jump', 'Nhảy lên', 'jumping mid-air with joy, arms up'],
    ['dance', 'Đang nhảy', 'dancing freely, caught mid-move'],
    ['run-laugh', 'Chạy cười đùa', 'running playfully while laughing, hair flying'],
    ['tuck-hair', 'Vén tóc', 'tucking hair behind one ear'],
  ]),
  ...group('pose', 'Cận cảnh & tay', [
    ['hands-frame-face', 'Hai tay ôm mặt', 'both hands gently framing the face'],
    ['hold-product', 'Cầm sản phẩm', 'holding a product near the face at chest height, presenting it to the camera'],
    ['hold-coffee', 'Cầm ly cà phê', 'holding an iced coffee cup with both hands near the chin'],
    ['chin-on-hand', 'Chống cằm', 'elbow on the table, chin resting on one hand'],
  ]),
  ...group('pose', 'Phong thái nam', [
    ['men-adjust-cuff', 'Chỉnh cổ tay áo', 'adjusting a shirt cuff with one hand, looking at the camera with a calm confident expression'],
    ['men-adjust-jacket', 'Cài khuy áo vest', 'buttoning a suit jacket while walking forward, composed and purposeful'],
    ['men-lean-back', 'Ngồi dựa thư thái', 'sitting back in an armchair, one ankle resting on the other knee, relaxed and confident'],
  ], 'male'),
];

// ── Looks (≥ 20) ─────────────────────────────────────────────────────

const LOOKS: SeedItem[] = [
  ...group('look', 'Phim', [
    ['kodak-portra-400', 'Kodak Portra 400', 'shot on Kodak Portra 400 film: warm natural skin tones, soft pastel highlights, fine organic grain'],
    ['fuji-pro-400h', 'Fuji Pro 400H', 'shot on Fujifilm Pro 400H film: airy cool-green tint, soft pastels, gentle grain'],
    ['kodak-gold-200', 'Kodak Gold 200', 'Kodak Gold 200 film look: golden warm tones, nostalgic saturated colours, visible grain'],
    ['cinestill-800t', 'CineStill 800T', 'CineStill 800T night film look: tungsten-balanced teal shadows, red halation around light sources, grain'],
    ['ilford-hp5', 'Ilford HP5 (đen trắng)', 'black-and-white Ilford HP5 film: rich contrast, deep blacks, pronounced grain'],
    ['fuji-superia', 'Fuji Superia', 'Fujifilm Superia consumer film: punchy greens, slightly cool, point-and-shoot snapshot feel'],
    ['polaroid', 'Polaroid', 'Polaroid instant-film look: faded colours, soft focus, slight colour shift and vignetting'],
    ['disposable-flash', 'Máy phim dùng một lần', 'disposable film camera with on-camera flash: harsh flash, slight overexposure, casual snapshot aesthetic'],
    ['autochrome', 'Autochrome', 'early-1900s autochrome colour photograph: pointillist starch-grain texture, muted dreamy colours'],
  ]),
  ...group('look', 'Điện ảnh', [
    ['wong-kar-wai', 'Wong Kar-wai', 'Wong Kar-wai cinematic look: saturated red and green neon, step-printed motion-blur feel, moody romantic Hong Kong night'],
    ['teal-orange', 'Teal & Orange', 'Hollywood teal-and-orange colour grade with cinematic contrast'],
    ['wes-anderson', 'Wes Anderson', 'Wes Anderson style: symmetrical framing, pastel palette, flat even lighting'],
    ['golden-hour', 'Giờ vàng điện ảnh', 'cinematic golden-hour backlight, warm rim light on the hair, gentle lens flare'],
    ['low-key', 'Low-key u tối', 'moody low-key lighting, deep shadows, a single soft key light'],
    ['anamorphic', 'Anamorphic', 'anamorphic cinema look: oval bokeh, horizontal blue lens flares, widescreen feel'],
    ['neo-noir', 'Neo-noir', 'neo-noir look: hard light through window blinds, high contrast, cool shadows'],
  ]),
  ...group('look', 'Editorial', [
    ['editorial-flash', 'Flash editorial', 'editorial direct flash: crisp hard light, sharp shadow behind the subject, glossy magazine look'],
    ['fashion-cover', 'Bìa tạp chí thời trang', 'high-fashion magazine cover lighting: beauty-dish key light, flawless but real skin, crisp detail'],
    ['clean-beauty', 'Beauty sáng trong', 'clean beauty look: soft diffused light, luminous dewy skin, minimal makeup'],
    ['ring-light', 'Ring light', 'ring-light beauty lighting with circular catchlights in the eyes'],
  ]),
  ...group('look', 'Màu sắc', [
    ['pastel-dream', 'Pastel mộng mơ', 'soft pastel colour palette, lifted shadows, airy dreamy mood'],
    ['nineties', 'Ảnh thập niên 90', '1990s photo look: slightly faded colours, warm cast, soft film grain'],
    ['korean-soft', 'Màu Hàn dịu', 'Korean soft-tone edit: bright exposure, low contrast, creamy skin, cool white balance'],
    ['bw-contrast', 'Đen trắng tương phản', 'high-contrast black-and-white, dramatic tones'],
  ]),
];

// ── Effects (≥ 10) ───────────────────────────────────────────────────

const EFFECTS: SeedItem[] = group('effect', 'Hiệu ứng', [
  ['bokeh', 'Bokeh nền', 'creamy bokeh background with soft out-of-focus lights'],
  ['motion-blur', 'Nhòe chuyển động', 'subtle motion blur in the background suggesting movement, subject sharp'],
  ['light-leak', 'Light leak', 'warm orange light leaks at the edge of the frame'],
  ['lens-flare', 'Lóa nắng', 'natural sun lens flare entering from a top corner'],
  ['rain', 'Mưa', 'light rain falling, wet surfaces with reflections'],
  ['snow', 'Tuyết rơi', 'gentle snowflakes falling'],
  ['haze', 'Sương mù', 'soft atmospheric haze and fog'],
  ['sun-dust', 'Bụi nắng', 'sunbeams with floating dust particles'],
  ['neon-reflections', 'Phản chiếu neon', 'neon light reflections on the face and surroundings'],
  ['leaf-shadows', 'Bóng lá', 'dappled leaf shadows falling across the face and body'],
  ['prism', 'Lăng kính', 'prism rainbow refraction streaks across part of the frame'],
  ['sparklers', 'Pháo bông que', 'holding sparklers with glowing light trails'],
  ['petals', 'Hoa rơi', 'flower petals falling through the air'],
]);

// ── Camera (≥ 40) ────────────────────────────────────────────────────
// Four independent axes; the Studio lets the owner pick one item per axis
// and joins their fragments (Selection.cameraIds). The groups are the axes:
// device & lens = 'Điện thoại' + 'Máy ảnh & ống kính', then 'Cỡ cảnh',
// 'Góc máy' and 'Chuyển động máy (video)'. Fragments stay on their own axis
// (a lens fragment says nothing about framing or angle) so any mix reads well.

const CAMERAS: SeedItem[] = [
  ...group('camera', 'Điện thoại', [
    ['iphone-front-selfie', 'Selfie camera trước', 'shot on an iPhone 15 front camera as an arm’s-length selfie: slight wide-angle distortion, smartphone HDR, natural phone image processing'],
    ['iphone-main', 'iPhone camera sau (1x)', 'shot on an iPhone 15 Pro main camera (24mm): sharp, natural phone colour science'],
    ['phone-ultrawide', 'Siêu rộng 0.5x', 'shot on an iPhone 0.5x ultra-wide camera (13mm): very wide field of view, stretched edges and playful wide-angle distortion up close'],
    ['phone-tele', 'Tele 5x điện thoại', 'shot on an iPhone 5x telephoto camera (120mm): compressed background, flattering facial proportions, natural phone colour science'],
    ['mirror-selfie', 'Selfie gương', 'mirror selfie taken in a full-length mirror, the phone visible in hand in the reflection'],
    ['friend-shot', 'Bạn chụp hộ', 'casual photo taken by a friend on a phone, slightly imperfect framing, candid'],
  ]),
  ...group('camera', 'Máy ảnh & ống kính', [
    ['fisheye', 'Mắt cá (fisheye)', '8mm fisheye lens: extreme 180-degree view with strongly curved lines, skate-video and streetwear energy'],
    ['24mm-wide', 'Góc rộng 24mm', '24mm wide-angle lens showing the environment, subject in context'],
    ['35mm-street', 'Street 35mm', '35mm lens street photography with environmental framing and natural perspective'],
    ['50mm', '50mm tự nhiên', '50mm f/1.8 lens: natural perspective close to human vision, gentle background blur'],
    ['85mm-portrait', 'Chân dung 85mm f/1.4', '85mm f/1.4 portrait lens: shallow depth of field, creamy background separation, flattering facial proportions'],
    ['135mm-tele', 'Tele 135mm', '135mm telephoto lens with a compressed background and strong subject isolation'],
    ['macro-face', 'Cận macro', '100mm macro close-up of the face with visible skin texture and eyelashes'],
    ['medium-format', 'Medium format', 'medium-format camera (Hasselblad): exceptional detail and smooth tonal transitions'],
    ['cinema-camera', 'Máy quay điện ảnh', 'shot on an ARRI Alexa cinema camera with a 40mm cine prime: wide dynamic range, soft highlight roll-off, filmic natural colour'],
  ]),
  ...group('camera', 'Cỡ cảnh', [
    ['shot-ecu', 'Đặc tả', 'extreme close-up framing on the eyes and lips, the face filling the frame edge to edge'],
    ['shot-cu', 'Cận cảnh', 'close-up framing of the face, from just below the chin to the top of the head'],
    ['shot-mcu', 'Cận trung', 'medium close-up framing from the chest up, head and shoulders in frame'],
    ['shot-ms', 'Trung cảnh', 'medium shot framed from the waist up'],
    ['shot-cowboy', 'Ba phần tư', 'medium-long shot framed from mid-thigh up'],
    ['shot-full', 'Toàn thân', 'full-body shot, head to toe in frame with a little space above the head and below the feet'],
    ['shot-wide', 'Toàn cảnh', 'wide shot: the subject small in the frame, the surroundings dominant'],
  ]),
  ...group('camera', 'Góc máy', [
    ['eye-level', 'Ngang tầm mắt', 'eye-level camera height, neutral and natural perspective'],
    ['high-angle', 'Góc cao', 'high-angle shot looking down at the subject'],
    ['low-angle', 'Góc thấp', 'low-angle shot looking up at the subject, empowering perspective'],
    ['worm-eye', 'Sát mặt đất', 'worm’s-eye view from ground level looking steeply up, dramatic towering perspective'],
    ['overhead', 'Từ trên xuống', 'top-down overhead shot'],
    ['dutch', 'Góc nghiêng', 'dutch tilt angle for dynamic energy'],
    ['over-shoulder', 'Sau lưng qua vai', 'over-the-shoulder view from just behind the subject, the back of the head and one shoulder soft in the foreground, looking at what the subject sees'],
    ['pov', 'Góc nhìn người xem (POV)', 'first-person point of view from the viewer’s eyes, as if the viewer is right there with the subject, who engages the viewer directly'],
    ['foreground', 'Qua tiền cảnh', 'shot through a soft out-of-focus foreground element (leaves, glass or fabric) that frames the subject and adds depth'],
  ]),
  ...group('camera', 'Chuyển động máy (video)', [
    ['static', 'Máy đứng yên', 'locked-off static camera on a tripod', ['video']],
    ['push-in', 'Đẩy máy chậm', 'slow cinematic push-in toward the face', ['video']],
    ['pull-back', 'Lùi máy hé lộ', 'slow pull-back revealing the surroundings', ['video']],
    ['pan', 'Lia ngang', 'slow smooth horizontal pan following the subject', ['video']],
    ['tilt-up', 'Lia dọc lên', 'slow tilt up from the feet to the face, revealing the outfit', ['video']],
    ['tracking', 'Trượt ngang theo', 'smooth lateral tracking shot moving alongside the subject at walking pace', ['video']],
    ['orbit', 'Xoay quanh', 'smooth orbit around the subject at chest height', ['video']],
    ['crane-up', 'Cẩu máy lên cao', 'crane shot rising smoothly up and away from the subject, revealing the location', ['video']],
    ['handheld-follow', 'Cầm tay theo sau', 'handheld camera following the subject with natural sway', ['video']],
    ['vlog-walk', 'Vlog cầm tay', 'handheld selfie-vlog camera at arm’s length, walking with the subject, natural gentle bounce', ['video']],
    ['crash-zoom', 'Zoom nhanh vào mặt', 'quick snap zoom into the face for comic emphasis', ['video']],
  ]),
];

export const BUILTIN_LIBRARY: SeedItem[] = [
  // Gestures and looks that read as feminine: the hair flip, the dress twirl, tucking hair, a bed pose, hands framing the face, the dewy beauty look.
  ...only(EXPRESSIONS, 'female', ['hair-flip']),
  ...HAIR, ...OUTFITS, ...SCENES,
  ...only(POSES, 'female', ['twirl', 'tuck-hair', 'bed-lying', 'hands-frame-face']),
  ...only(LOOKS, 'female', ['clean-beauty']),
  ...EFFECTS, ...CAMERAS,
];

/**
 * Builtins whose text changed after they first shipped, with the text they
 * shipped with. The seed moves a row to the current text only while it still
 * holds exactly that old text, so an owner's edit is never overwritten.
 */
export const REVISED_BUILTINS: { id: string; group: string; name: string; prompt: string }[] = [
  { id: 'b-camera-iphone-front-selfie', group: 'Điện thoại', name: 'iPhone 15 camera trước (selfie)', prompt: 'shot on an iPhone 15 front camera as an arm’s-length selfie: slight wide-angle distortion, smartphone HDR, natural phone image processing' },
  { id: 'b-camera-iphone-main', group: 'Điện thoại', name: 'iPhone 15 Pro camera sau', prompt: 'shot on an iPhone 15 Pro main camera (24mm): sharp, natural phone colour science' },
  { id: 'b-camera-phone-ultrawide', group: 'Điện thoại', name: 'Góc rộng 0.5x', prompt: 'iPhone 0.5x ultra-wide shot from a low angle with playful distortion' },
  { id: 'b-camera-50mm', group: 'Máy ảnh & ống kính', name: '50mm tự nhiên', prompt: '50mm f/1.8 lens, natural perspective, medium shot' },
  { id: 'b-camera-85mm-portrait', group: 'Máy ảnh & ống kính', name: 'Chân dung 85mm f/1.4', prompt: '85mm f/1.4 portrait lens at eye level: shallow depth of field, creamy background separation' },
];

/**
 * Builtins taken out of the library, with the text they shipped with. An
 * untouched row is deleted; an edited one is handed to the owner (builtin = 0)
 * so it stays and can be deleted by hand.
 */
export const RETIRED_BUILTINS: { id: string; group: string; name: string; prompt: string }[] = [
  // The aspect ratio already sets the frame; this fragment fought 16:9 and 1:1.
  { id: 'b-camera-vertical-phone', group: 'Điện thoại', name: 'Khung dọc điện thoại', prompt: 'vertical smartphone frame, handheld feel' },
];
