// Template packs ("mẫu edit") for Dựng nhanh. Contract shared with plan v2 (T1), the director prompt (T3),
// the composition (T4) and the web (T6/T7): see docs/dung-nhanh-gd1-plan.md › Template.
//
// A pack is a folder: template.json (TemplateManifest), rules.md (director rules) and components/*.html.
// Each component file is a HyperFrames sub-composition (<template> → root with data-composition-id = the
// component id, one paused GSAP timeline registered on window.__timelines[id]); mount it with
// data-composition-src so the HyperFrames compiler scopes its CSS, ids and script per instance.
// Props arrive as composition variables (`data-variable-values` on the host slot), one per prop id:
// markup/text as the raw string, list as a JSON array or one item per line, number as a number, asset as
// the resolved file path (the plan holds an assetId). Every block also reads `duration` (seconds, the slot
// length) and `animIn` (preset id); broll-frame reads `layout` and `image` or `video` (the B-roll file).
// Theme tokens arrive as inherited CSS custom properties: --th-font-title, --th-font-sub, --th-font-caption
// (family names the composition declared with @font-face from the module font library) and --th-<color key>.
import type { CaptionStyle, VideoAspect } from '../types.js';

// CaptionStyle lives in ../types.ts (shared with overrides.json); re-exported here for template code.
export type { CaptionStyle };

export interface PropDef {
  type: 'text' | 'markup' | 'list' | 'number' | 'color' | 'asset';
  label: string;
  required?: boolean;
  maxWords?: number; maxLines?: number; maxItems?: number;
}

export interface ComponentDef {
  kind: 'beat' | 'scene' | 'graphic' | 'broll-frame';
  label: string;
  file: string;                         // sub-composition HyperFrames, đường dẫn tương đối trong thư mục mẫu
  runtime: 'gsap' | 'lottie' | 'three' | 'animejs' | 'css' | 'waapi' | 'typegpu';
  props: Record<string, PropDef>;
  duration: { min: number; max: number; default: number };
  animations?: string[];                // preset hiệu ứng vào được phép; mặc định tất cả
  safeZone?: { top: number; bottom: number };  // % khung dọc không được đặt chữ lớn
  useWhen?: string; avoidWhen?: string; // cho đạo diễn
}

export interface TemplateManifest {
  id: string; version: string; name: string; description: string;
  tags: string[]; tier: 'free' | 'pro'; aspects: VideoAspect[];
  poster?: string; preview?: string;
  styleId?: string;                     // VideoStyle nền (cutPace, musicMoods, sfxDensity)
  tokens: { fonts: { title: string; sub: string; caption: string }; colors: Record<string, string> };
  captions: CaptionStyle;
  components: Record<string, ComponentDef>;
  animations: { id: string; label: string; sound?: string }[];   // sound: id SFX khi sound.mode auto
  sounds: { density: 'none' | 'low' | 'medium' | 'high'; transition?: string; click?: string };
  rules: string;                        // tên file luật cho đạo diễn, thường 'rules.md'
  license?: { source: string; attribution?: string };
  legacy?: boolean;                     // mẫu bọc VideoStyle cũ, dùng overlays cũ
}

export interface TemplateSummary {
  id: string; name: string; description: string; tags: string[]; tier: 'free' | 'pro';
  installed: boolean; legacy: boolean; posterUrl?: string; previewUrl?: string;
  sample?: { kicker?: string; title: string; font: string; color: string; tone: string };  // để vẽ thẻ khi chưa có poster
}
