// Prompts of the Asset Hub agent turns, and the parsers of their JSON answers.
//
// clipIndexPrompt translates and adapts FireRed-OpenStoryline `prompts/tasks/understand_clips/*/system_detail.md`
// and musicLabelPrompt adapts `prompts/tasks/scripts/*/omni_bgm_label.md` (Copyright 2026 FireRed-OpenStoryline
// Authors, Apache License 2.0; see THIRD_PARTY_NOTICES.md). Changes: Vietnamese output, frames sent as pictures
// in one turn, `aes_score` renamed `quality`; music is labelled from measured tempo/energy, its text and a
// spectrogram (the agent cannot hear audio), with the studio's six moods. The B-roll scoring prompt is our own:
// it follows OpenMontage's idea (idea only, AGPL code not used) of a full description to score and short
// keywords to search.
import { jsonObjectsOf } from '../../kol-port.js';
import { BGM_MOODS } from '../catalog/assets.js';
import type { AssetCandidate } from './types.js';

export const MUSIC_GENRES = ['Pop', 'BGM', 'Electronic', 'R&B/Soul', 'Hip Hop/Rap', 'Rock', 'Jazz', 'Folk', 'Classical', 'Cinematic', 'Lo-fi'] as const;

const fmtSec = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}` : `${Math.round(sec * 10) / 10}s`);

// ── Index: describe a clip or picture ──

export function clipIndexPrompt(input: { kind: 'video' | 'image'; name: string; durationSec?: number; frames: number; note?: string }): string {
  const what = input.kind === 'video'
    ? `${input.frames} khung hình (theo thứ tự thời gian) trích từ một đoạn video${input.durationSec ? ` dài ${fmtSec(input.durationSec)}` : ''}`
    : 'một ảnh';
  return [
    `Bạn là người dựng video ngắn giỏi đọc nội dung hình ảnh. Hãy xem ${what} trong kho tư liệu, phân tích kỹ nội dung và chấm chất lượng thẩm mỹ.`,
    '',
    '1. Mô tả (caption), viết bằng tiếng Việt:',
    '- Nội dung: chủ thể chính, hành động của chủ thể, bố cục cảnh, môi trường (trong nhà/ngoài trời, ngày/đêm, thời tiết), góc máy và cảm xúc chung của khung hình.',
    '- Hành động và nét mặt: tả cụ thể hành động và nét mặt của người, vật trong khung.',
    '- Nhiều cảnh: nếu có nhiều cảnh hoặc chuyển cảnh, tả đủ các cảnh và nối lời tả cho tự nhiên.',
    '- Đúng thực tế: chỉ tả những gì nhìn thấy; không tưởng tượng, không bịa chi tiết không có trong hình.',
    '- Chọn lọc: tập trung vào chủ thể và yếu tố chính, có thể bỏ chi tiết nền vụn vặt nhưng không bỏ sót chủ thể quan trọng (người, con vật…).',
    '- Ngắn gọn: tối đa 100 chữ.',
    '',
    '2. Điểm chất lượng (quality): số thực từ 0.0 đến 1.0, làm tròn hai chữ số, xét:',
    '- Độ nét: độ phân giải, chi tiết bề mặt, có nhiễu, vỡ hình, dấu nén hay không, lấy nét đúng hay mờ.',
    '- Ánh sáng và màu: phơi sáng đúng (không cháy sáng, không tối đen), ánh sáng tự nhiên hoặc có chủ ý, màu và cân bằng trắng đúng.',
    '- Bố cục và chủ thể: bố cục hợp lý (một phần ba, cân giữa), chủ thể nổi bật, không bị nền rối hay vật khác che.',
    '- Độ ổn định: chuyển động máy mượt, không rung giật hay lia loạn.',
    'Thang tham khảo:',
    '- 0.80–1.00 (Xuất sắc): rất nét, ánh sáng chăm chút, bố cục chuyên nghiệp, chủ thể nổi bật, máy ổn định (mức điện ảnh, vlog chuyên nghiệp).',
    '- 0.60–0.79 (Tốt): nét, phơi sáng bình thường, màu tự nhiên, bố cục gọn; không xuất sắc nhưng đầy đủ (mức vlog thông thường).',
    '- 0.40–0.59 (Trung bình): nhận ra nội dung chính nhưng hơi mờ, rung, thiếu sáng hoặc bố cục rối (mức tư liệu thô).',
    '- 0.00–0.39 (Kém): rất mờ, rung mạnh, quá tối hoặc cháy sáng, không nhận ra chủ thể (mức bỏ đi).',
    '',
    `Tên file: ${input.name}`,
    ...(input.note ? [`Ghi chú có sẵn (chỉ để tham khảo, vẫn tả theo hình): ${input.note}`] : []),
    '',
    '3. Chỉ trả về đúng một đối tượng JSON, không giải thích thêm:',
    '{"caption": "mô tả tiếng Việt, tối đa 100 chữ", "quality": 0.72}',
  ].join('\n');
}

export function parseClipIndex(output: string): { caption: string; quality?: number } | null {
  for (const o of jsonObjectsOf(output)) {
    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    const caption = typeof r.caption === 'string' ? r.caption.trim().replace(/\s+/g, ' ').slice(0, 600) : '';
    if (!caption) continue;
    const q = Number(r.quality ?? r.aes_score);
    return { caption, ...(Number.isFinite(q) ? { quality: Math.round(Math.min(1, Math.max(0, q)) * 100) / 100 } : {}) };
  }
  return null;
}

// ── Index: label a music track ──

export function musicLabelPrompt(input: {
  name: string; description?: string; tags?: string[]; mood?: string; durationSec?: number;
  bpm?: number; energyMeanDb?: number; dynamicRangeDb?: number; spectrogram: boolean;
}): string {
  const facts = [
    input.durationSec ? `dài ${fmtSec(input.durationSec)}` : '',
    input.bpm ? `khoảng ${Math.round(input.bpm)} BPM` : '',
    input.energyMeanDb !== undefined ? `năng lượng trung bình ${Math.round(input.energyMeanDb)} dBFS` : '',
    input.dynamicRangeDb !== undefined ? `chênh lệch to nhỏ ${Math.round(input.dynamicRangeDb)} dB` : '',
  ].filter(Boolean).join(', ');
  return [
    'Bạn là chuyên gia phân tích nhạc nền cho video ngắn. Máy không gửi được âm thanh cho bạn; bạn có số đo của máy, thông tin bài'
      + (input.spectrogram ? ' và ảnh phổ âm thanh đính kèm (trục ngang là thời gian, trục dọc là tần số, càng sáng càng mạnh; giọng hát thường hiện thành các dải hài âm uốn lượn ở vùng giữa).' : '.'),
    '',
    `Bài: "${input.name}"${facts ? ` (${facts})` : ''}`,
    ...(input.description ? [`Mô tả có sẵn: ${input.description}`] : []),
    ...(input.tags?.length ? [`Thẻ: ${input.tags.join(', ')}`] : []),
    ...(input.mood ? [`Mood đã gắn: ${input.mood}`] : []),
    '',
    'Chỉ trả về đúng một đối tượng JSON với các trường sau, không thêm trường, không giải thích:',
    '{',
    `  "mood": "",        // chọn một mood hợp nhất trong: ${BGM_MOODS.map((m) => m.label).join(', ')}`,
    `  "genre": "",       // chọn một thể loại hợp nhất trong: ${MUSIC_GENRES.join(', ')}`,
    '  "vocals": false,   // true khi bài có lời hát, false khi chỉ có nhạc',
    '  "description": ""  // một câu tiếng Việt: cảm xúc, hợp cảnh nào, nhạc cụ chính',
    '}',
    'Mọi trường phải có giá trị cụ thể; trả JSON thuần, bỏ các dòng chú thích //. Không chắc thì dựa vào tên, mô tả, thẻ và nhịp; không bịa chi tiết.',
  ].join('\n');
}

export function parseMusicLabel(output: string): { mood?: string; genre?: string; vocals?: boolean; description?: string } | null {
  for (const o of jsonObjectsOf(output)) {
    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    const pick = (v: unknown) => (Array.isArray(v) ? v[0] : v);
    const moodRaw = String(pick(r.mood) ?? '').trim().toLowerCase();
    const mood = BGM_MOODS.find((m) => m.label.toLowerCase() === moodRaw)?.label;
    const genreRaw = String(pick(r.genre) ?? '').trim().toLowerCase();
    const genre = MUSIC_GENRES.find((g) => g.toLowerCase() === genreRaw);
    const vocals = typeof r.vocals === 'boolean' ? r.vocals : undefined;
    const description = typeof r.description === 'string' ? r.description.trim().slice(0, 400) : undefined;
    if (!mood && !genre && vocals === undefined && !description) continue;
    return { ...(mood ? { mood } : {}), ...(genre ? { genre } : {}), ...(vocals !== undefined ? { vocals } : {}), ...(description ? { description } : {}) };
  }
  return null;
}

// ── B-roll: score candidates against the line being spoken ──

const SOURCE_LABEL: Record<AssetCandidate['source'], string> = { project: 'tư liệu chủ kênh', mine: 'kho của tôi', pexels: 'Pexels', 'pexels-photo': 'Pexels ảnh' };

export function brollScorePrompt(input: { line?: string; description: string; keywords: string[]; candidates: AssetCandidate[]; imageOf: (number | null)[] }): string {
  const rows = input.candidates.map((c, i) => {
    const kind = c.kind === 'video' ? `video${c.durationSec ? ` ${Math.round(c.durationSec)}s` : ''}` : 'ảnh';
    const img = input.imageOf[i];
    return `${i + 1}. ${kind} · ${SOURCE_LABEL[c.source]} · "${c.caption.slice(0, 200)}"${img ? ` (ảnh ${img})` : ' (không có ảnh, chấm theo mô tả)'}`;
  });
  return [
    'Bạn chọn cảnh trám (B-roll) cho một video ngắn tiếng Việt. Cảnh trám hiện lên trong lúc người nói đọc câu dưới đây.',
    '',
    ...(input.line ? [`Câu đang nói: "${input.line}"`] : []),
    `Cảnh cần có: ${input.description}`,
    ...(input.keywords.length ? [`Từ khoá đã dùng để tìm: ${input.keywords.join(', ')}`] : []),
    '',
    `Ứng viên (${input.candidates.length}); ảnh nhỏ đính kèm theo đúng số thứ tự ghi trong ngoặc:`,
    ...rows,
    '',
    'Chấm từng ứng viên từ 1 đến 5: 5 = đúng ý câu đang nói, rõ, đẹp; 4 = hợp, dùng tốt; 3 = dùng được; 2 = lệch ý; 1 = lạc đề hoặc xấu.',
    'Trừ điểm khi: có chữ, logo hay watermark lớn; mờ, tối, rung; không hợp khung dọc; cảnh quảng cáo giả tạo.',
    'Chỉ trả về một đối tượng JSON, không giải thích thêm:',
    '{"scores": [{"n": 1, "score": 4, "reason": "lý do ngắn"}]}',
  ].join('\n');
}

export function parseScores(output: string, count: number): Map<number, { score: number; reason?: string }> {
  const out = new Map<number, { score: number; reason?: string }>();
  for (const o of jsonObjectsOf(output)) {
    const list = (o as { scores?: unknown })?.scores;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const r = item as Record<string, unknown>;
      const n = Number(r?.n);
      const score = Number(r?.score);
      if (!Number.isInteger(n) || n < 1 || n > count || !Number.isFinite(score)) continue;
      const reason = typeof r.reason === 'string' ? r.reason.trim().slice(0, 200) : '';
      out.set(n - 1, { score: Math.min(5, Math.max(1, Math.round(score))), ...(reason ? { reason } : {}) });
    }
    if (out.size > 0) break;
  }
  return out;
}
