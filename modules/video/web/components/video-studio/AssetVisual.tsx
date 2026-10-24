import type { VideoAsset } from '@modules/video/web/lib/video-edit/types';
import { assetFileUrl } from '@modules/video/web/lib/video-edit/library-api';
import creatorStudio from '@modules/video/web/assets/video-studio/creator-studio.webp';
import creatorCafe from '@modules/video/web/assets/video-studio/creator-cafe.webp';

const IMAGE_FILE = /\.(png|jpe?g|webp|gif|svg)$/i;
const VIDEO_FILE = /\.(mp4|mov|webm)$/i;

/** A small, explicitly illustrative scene for code-native effects and captions. */
function DemoScene({ asset }: { asset: VideoAsset }) {
  const slug = asset.id.split(':').slice(1).join(':');
  const caption = asset.kind === 'caption';
  const scene = caption || ['comment-bubble', 'handwriting', 'soft-blur', 'sticker-label'].includes(slug) ? creatorCafe : creatorStudio;
  let content;
  switch (slug) {
    case 'two-tier-hook': content = <><span class="vs-demo-kicker">BẠN CÓ BIẾT?</span><strong class="vs-demo-title">Ý TƯỞNG<br />BỨT PHÁ</strong></>; break;
    case 'karaoke-follow': case 'karaoke': content = <span class="vs-demo-caption">Làm <em>video</em> dễ hơn</span>; break;
    case 'keyword-pop': case 'single-word-pop': content = <strong class="vs-demo-pop">BỨT PHÁ!</strong>; break;
    case 'compare-ab': content = <div class="vs-demo-compare"><span>TRƯỚC</span><span>SAU</span></div>; break;
    case 'stacked-list': content = <div class="vs-demo-list"><span>✓ Ý thứ nhất</span><span>✓ Ý thứ hai</span><span>✓ Ý thứ ba</span></div>; break;
    case 'count-up': content = <strong class="vs-demo-number">12.8K<span> LƯỢT XEM</span></strong>; break;
    case 'hand-circle': content = <span class="vs-demo-circle">ĐIỂM NHẤN</span>; break;
    case 'comment-bubble': content = <span class="vs-demo-comment">💬 Video này hay quá!</span>; break;
    case 'glitch-decode': content = <strong class="vs-demo-glitch">AI_2026</strong>; break;
    case 'glow-text': case 'gradient-glow': content = <strong class="vs-demo-glow">TƯƠNG LAI</strong>; break;
    case 'slide-up': content = <strong class="vs-demo-slide">BẮT ĐẦU NGAY ↑</strong>; break;
    case 'soft-blur': content = <span class="vs-demo-soft">“Một câu chuyện đáng nhớ”</span>; break;
    case 'handwriting': case 'handwritten': content = <span class="vs-demo-hand">Một ngày thật đẹp…</span>; break;
    case 'typewriter': case 'typewriter-caption': content = <span class="vs-demo-type">&gt; Bắt đầu_</span>; break;
    case 'numbered-steps': content = <strong class="vs-demo-step"><b>01</b><span>BƯỚC ĐẦU TIÊN</span></strong>; break;
    case 'chapter-opener': content = <strong class="vs-demo-chapter">CHƯƠNG 01<span>KHỞI ĐẦU</span></strong>; break;
    case 'sticker-label': content = <span class="vs-demo-sticker">MỚI • -20%</span>; break;
    case 'underline': content = <strong class="vs-demo-underline">RẤT QUAN TRỌNG</strong>; break;
    case 'pointing-arrow': content = <span class="vs-demo-arrow">↘ <b>XEM Ở ĐÂY</b></span>; break;
    case 'outro-follow': content = <span class="vs-demo-follow">+ THEO DÕI</span>; break;
    case 'pair-words': content = <span class="vs-demo-caption">CÙNG <em>LÀM</em></span>; break;
    case 'behind-subject': content = <strong class="vs-demo-behind">KHÁM PHÁ</strong>; break;
    case 'boxed': content = <span class="vs-demo-boxed">Một ý thật dễ hiểu</span>; break;
    case 'outline-highlight': content = <span class="vs-demo-outline">LÀM <em>VIDEO</em> HAY</span>; break;
    case 'bottom-clean': content = <span class="vs-demo-clean">Một dòng phụ đề rõ ràng</span>; break;
    case 'highlight-bar': content = <span class="vs-demo-highlight">Bắt đầu <em>ngay hôm nay</em></span>; break;
    case 'bold-uppercase': content = <strong class="vs-demo-bold">THAY ĐỔI<br />NGAY!</strong>; break;
    default: content = <strong class="vs-demo-title">{asset.name}</strong>;
  }
  return <div class={`vs-demo-scene vs-demo-${caption ? 'caption' : 'effect'} vs-demo-${slug}`} aria-hidden="true">
    <img class="vs-demo-frame" src={scene} alt="" loading="lazy" />
    <span class="vs-demo-shade" />{content}
  </div>;
}

export function AssetVisual({ asset, large = false }: { asset: VideoAsset; large?: boolean }) {
  const fileUrl = asset.file && asset.available ? assetFileUrl(asset.id, asset.updatedAt) : null;
  const className = `vs-asset-visual${large ? ' is-large' : ''}`;
  if (asset.kind === 'effect' || asset.kind === 'caption') return <div class={className}><DemoScene asset={asset} /></div>;
  if (fileUrl && IMAGE_FILE.test(asset.file!)) return <div class={className}><img src={fileUrl} alt="" loading="lazy" /></div>;
  if (fileUrl && VIDEO_FILE.test(asset.file!)) return <div class={className}><video src={fileUrl} preload="metadata" muted playsInline onLoadedMetadata={(e) => { e.currentTarget.currentTime = Math.min(0.5, e.currentTarget.duration / 4); }} /></div>;
  if (asset.kind === 'font') {
    const family = `vs-preview-${asset.id.replace(/[^a-z0-9]/gi, '-')}`;
    const css = fileUrl ? `@font-face{font-family:'${family}';src:url('${fileUrl}');font-display:swap}` : '';
    return <div class={`${className} vs-visual-font`}>{css && <style>{css}</style>}<span style={{ fontFamily: fileUrl ? `'${family}',sans-serif` : 'sans-serif' }}>Aa Ă ă</span></div>;
  }
  if (asset.kind === 'bgm' || asset.kind === 'sfx') return <div class={`${className} vs-visual-audio`} aria-hidden="true"><span>♪</span><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>;
  const slug = asset.id.split(':').slice(1).join(':');
  return <div class={`${className} vs-visual-abstract vs-visual-${asset.kind} vs-visual-${slug}`} aria-hidden="true"><span>{asset.kind === 'lut' ? 'A / B' : asset.kind === 'overlay' ? '✦' : '◈'}</span></div>;
}
