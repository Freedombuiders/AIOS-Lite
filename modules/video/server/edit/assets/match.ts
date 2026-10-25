// Word matching between the transcript / a director query and library captions. Vietnamese meaning lives in
// syllable pairs ("cà phê", "bàn phím") and accents tell words apart ("cho" / "chó" / "chợ"), so words and
// pairs are compared with their accents; accent-free pairs count once more for text typed without accents.
import { normalizeText } from '../catalog/assets.js';

const STOP = new Set([
  'và', 'của', 'là', 'có', 'một', 'những', 'các', 'cho', 'với', 'trong', 'này', 'đó', 'thì', 'mà', 'để', 'được', 'không',
  'như', 'khi', 'ra', 'vào', 'lên', 'từ', 'đến', 'thế', 'nào', 'gì', 'rồi', 'cũng', 'còn', 'nữa', 'sẽ', 'đã', 'đang', 'rất',
  'làm', 'bạn', 'mình', 'tôi', 'chúng', 'ta', 'ấy', 'nhé', 'nha', 'ơi', 'vậy', 'đây', 'kia', 'hay', 'hoặc', 'nếu', 'vì', 'nên',
  'cái', 'nhiều', 'ít', 'qua', 'về', 'theo', 'tại', 'sau', 'trước', 'bị', 'bởi', 'cả', 'mỗi', 'từng', 'điều', 'việc', 'ở',
  'the', 'an', 'of', 'in', 'on', 'at', 'to', 'and', 'or', 'with', 'for', 'is', 'are', 'by', 'from', 'as', 'it', 'its', 'this', 'that',
]);

export interface Terms {
  words: Set<string>;
  pairs: Set<string>;
  /** Pairs without accents. */
  loose: Set<string>;
}

export function terms(text: string): Terms {
  const tokens = text.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2 && !STOP.has(t));
  const pairs = new Set<string>();
  const loose = new Set<string>();
  for (let i = 1; i < tokens.length; i++) {
    const pair = `${tokens[i - 1]} ${tokens[i]}`;
    pairs.add(pair);
    loose.add(normalizeText(pair));
  }
  return { words: new Set(tokens), pairs, loose };
}

/** Shared words + shared pairs (2 with accents, 1 without). 0 = nothing in common. */
export function matchScore(query: Terms, doc: Terms): number {
  let score = 0;
  for (const w of query.words) if (doc.words.has(w)) score += 1;
  for (const p of query.pairs) if (doc.pairs.has(p)) score += 1;
  for (const p of query.loose) if (doc.loose.has(p)) score += 1;
  return score;
}
