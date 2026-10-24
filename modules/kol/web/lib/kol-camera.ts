/**
 * Camera setup for KOL Studio. The camera library sits on independent axes
 * (device & lens, shot size, angle, movement); the owner picks at most one
 * item per axis and the server joins them into one "Camera:" line
 * (Selection.cameraIds). Builtin items get a Vietnamese hint, a short spec and
 * a diagram here; the owner's own items fall back to their group.
 */
import type { LibraryItemDto } from './kol';

export type CameraContext = 'image' | 'video';
export type CameraAxisId = 'device' | 'shot' | 'angle' | 'move' | 'custom';

export interface CameraAxis {
  id: CameraAxisId;
  label: string;
  /** Prefix on summary chips ("Góc: Góc thấp"). */
  short: string;
  hint: string;
  /** Library groups that belong to this axis (the builtin seed's group names). */
  groups: string[];
}

export const CAMERA_AXES: CameraAxis[] = [
  { id: 'device', label: 'Thiết bị & ống kính', short: 'Máy', hint: 'Quyết định chất ảnh: điện thoại hay máy ảnh, tiêu cự, độ xoá phông.', groups: ['Điện thoại', 'Máy ảnh & ống kính'] },
  { id: 'shot', label: 'Cỡ cảnh', short: 'Cỡ', hint: 'Khung hình lấy đến đâu trên người nhân vật.', groups: ['Cỡ cảnh'] },
  { id: 'angle', label: 'Góc máy', short: 'Góc', hint: 'Máy đặt ở đâu so với nhân vật: cao, thấp, nghiêng, sau lưng…', groups: ['Góc máy'] },
  { id: 'move', label: 'Chuyển động máy', short: 'Chuyển động', hint: 'Máy di chuyển thế nào trong clip. Chỉ áp dụng cho video.', groups: ['Chuyển động máy (video)'] },
  { id: 'custom', label: 'Của tôi', short: 'Riêng', hint: 'Thiết lập bạn tự thêm ở Thư viện, ngoài các nhóm có sẵn.', groups: [] },
];
const AXIS_BY_ID = new Map(CAMERA_AXES.map((a) => [a.id, a]));
const AXIS_ORDER = CAMERA_AXES.map((a) => a.id);

export function cameraAxisOf(item: Pick<LibraryItemDto, 'group'>): CameraAxisId {
  return CAMERA_AXES.find((a) => a.groups.includes(item.group))?.id ?? 'custom';
}

export function cameraAxis(id: CameraAxisId): CameraAxis {
  return AXIS_BY_ID.get(id)!;
}

/** Movement items, and any item tagged "video", only make sense in a clip. */
export function isVideoOnlyCamera(item: Pick<LibraryItemDto, 'group' | 'tags'>): boolean {
  return cameraAxisOf(item) === 'move' || item.tags.includes('video');
}

/**
 * Axes with their items for a context, items in library order. Video puts
 * movement first (it matters most in a clip); images drop video-only items.
 */
export function cameraSections(items: LibraryItemDto[], context: CameraContext): { axis: CameraAxis; items: LibraryItemDto[] }[] {
  const order: CameraAxisId[] = context === 'video' ? ['move', 'device', 'shot', 'angle', 'custom'] : ['device', 'shot', 'angle', 'custom'];
  const sorted = [...items].sort((a, b) => a.sort - b.sort);
  return order
    .map((id) => ({ axis: cameraAxis(id), items: sorted.filter((it) => cameraAxisOf(it) === id && (context === 'video' || !isVideoOnlyCamera(it))) }))
    .filter((s) => s.items.length > 0);
}

/**
 * Known ids only, one per axis (the later pick wins), in prompt order:
 * device, shot, angle, movement, custom.
 */
export function normalizeCameraPicks(ids: readonly string[], byId: ReadonlyMap<string, LibraryItemDto>): string[] {
  const perAxis = new Map<CameraAxisId, string>();
  for (const id of ids) {
    const it = byId.get(id);
    if (it?.kind === 'camera') perAxis.set(cameraAxisOf(it), id);
  }
  return AXIS_ORDER.filter((a) => perAxis.has(a)).map((a) => perAxis.get(a)!);
}

/** Clicking a tile: unpick it, or pick it in place of the axis' current pick. */
export function toggleCameraPick(ids: readonly string[], item: LibraryItemDto, byId: ReadonlyMap<string, LibraryItemDto>): string[] {
  if (ids.includes(item.id)) return ids.filter((id) => id !== item.id);
  return normalizeCameraPicks([...ids, item.id], byId);
}

/** The pick on one axis, if any. */
export function cameraPickOn(ids: readonly string[], axis: CameraAxisId, byId: ReadonlyMap<string, LibraryItemDto>): LibraryItemDto | null {
  for (const id of ids) {
    const it = byId.get(id);
    if (it && cameraAxisOf(it) === axis) return it;
  }
  return null;
}

/** Camera picks of a selection: cameraIds, else the single legacy cameraId. */
export function selectionCameraIds(sel: { cameraId?: string; cameraIds?: string[] }): string[] {
  return sel.cameraIds?.length ? sel.cameraIds : sel.cameraId ? [sel.cameraId] : [];
}

// ── Builtin descriptions and diagrams ────────────────────────────────

export type ShotSize = 'ecu' | 'cu' | 'mcu' | 'ms' | 'cowboy' | 'full' | 'wide';
export type CameraArtSpec =
  | { t: 'lens'; fov: number; body?: 'camera' | 'phone' | 'cine' | 'mf'; near?: boolean; fisheye?: boolean }
  | { t: 'shot'; shot: ShotSize }
  | { t: 'angle'; angle: 'eye' | 'high' | 'low' | 'worm' | 'overhead' | 'dutch' | 'ots' | 'pov' | 'foreground' }
  | { t: 'move'; move: 'static' | 'push' | 'pull' | 'pan' | 'tilt' | 'track' | 'orbit' | 'crane' | 'follow' | 'vlog' | 'zoom' }
  | { t: 'scene'; scene: 'selfie' | 'mirror' | 'friend' };

export interface CameraInfo {
  /** What it does for the picture, in Vietnamese. */
  hint: string;
  /** Short technical label shown on the tile ("85mm f/1.4", "MCU"). */
  spec?: string;
  art: CameraArtSpec;
}

const info = (spec: string | undefined, hint: string, art: CameraArtSpec): CameraInfo => ({ spec, hint, art });

export const CAMERA_INFO: Record<string, CameraInfo> = {
  // Điện thoại
  'b-camera-iphone-front-selfie': info('Camera trước', 'Tự cầm máy chụp, hơi méo góc rộng — đúng chất ảnh đời thường.', { t: 'scene', scene: 'selfie' }),
  'b-camera-iphone-main': info('24mm', 'Ảnh điện thoại sắc nét, màu tự nhiên, hợp đăng hằng ngày.', { t: 'lens', body: 'phone', fov: 70 }),
  'b-camera-phone-ultrawide': info('13mm', 'Rất rộng, méo vui mắt khi đứng gần; chụp từ thấp cho chân dài.', { t: 'lens', body: 'phone', fov: 112 }),
  'b-camera-phone-tele': info('120mm', 'Nén hậu cảnh, mặt cân đối, chụp từ xa vẫn đẹp.', { t: 'lens', body: 'phone', fov: 20 }),
  'b-camera-mirror-selfie': info('Gương', 'Thấy điện thoại trong gương, khoe trọn bộ đồ.', { t: 'scene', scene: 'mirror' }),
  'b-camera-friend-shot': info('Người khác chụp', 'Bố cục hơi lệch, tự nhiên như bạn bè chụp hộ.', { t: 'scene', scene: 'friend' }),
  // Máy ảnh & ống kính
  'b-camera-fisheye': info('8mm', 'Cong mạnh 180°, chất skate và streetwear.', { t: 'lens', fov: 170, fisheye: true }),
  'b-camera-24mm-wide': info('24mm', 'Thấy nhiều bối cảnh, nhân vật nằm trong không gian.', { t: 'lens', fov: 74 }),
  'b-camera-35mm-street': info('35mm', 'Góc nhìn đường phố, có bối cảnh mà không méo.', { t: 'lens', fov: 54 }),
  'b-camera-50mm': info('50mm f/1.8', 'Gần với mắt người, xoá phông nhẹ.', { t: 'lens', fov: 40 }),
  'b-camera-85mm-portrait': info('85mm f/1.4', 'Ống chân dung kinh điển: xoá phông mềm, gương mặt đẹp.', { t: 'lens', fov: 24 }),
  'b-camera-135mm-tele': info('135mm', 'Tách nền mạnh, hậu cảnh bị nén sát lại.', { t: 'lens', fov: 15 }),
  'b-camera-macro-face': info('100mm macro', 'Thấy rõ da, mi — hợp ảnh beauty thật cận.', { t: 'lens', fov: 16, near: true }),
  'b-camera-medium-format': info('Hasselblad', 'Chi tiết rất cao, chuyển tông mượt, chất ảnh tạp chí.', { t: 'lens', fov: 42, body: 'mf' }),
  'b-camera-cinema-camera': info('ARRI · 40mm', 'Màu và dải sáng điện ảnh, đẹp nhất cho video.', { t: 'lens', fov: 46, body: 'cine' }),
  // Cỡ cảnh
  'b-camera-shot-ecu': info('ECU', 'Chỉ mắt và môi, đầy khung hình.', { t: 'shot', shot: 'ecu' }),
  'b-camera-shot-cu': info('CU', 'Trọn khuôn mặt, cảm xúc rõ nhất.', { t: 'shot', shot: 'cu' }),
  'b-camera-shot-mcu': info('MCU', 'Từ ngực trở lên — cỡ chân dung phổ biến nhất.', { t: 'shot', shot: 'mcu' }),
  'b-camera-shot-ms': info('MS', 'Từ eo trở lên, thấy tay và áo.', { t: 'shot', shot: 'ms' }),
  'b-camera-shot-cowboy': info('MLS', 'Từ giữa đùi trở lên, khoe dáng và trang phục.', { t: 'shot', shot: 'cowboy' }),
  'b-camera-shot-full': info('FS', 'Trọn người từ đầu đến chân.', { t: 'shot', shot: 'full' }),
  'b-camera-shot-wide': info('WS', 'Nhân vật nhỏ, bối cảnh là chính.', { t: 'shot', shot: 'wide' }),
  // Góc máy
  'b-camera-eye-level': info(undefined, 'Trung tính, tự nhiên như đang trò chuyện.', { t: 'angle', angle: 'eye' }),
  'b-camera-high-angle': info(undefined, 'Nhìn xuống: mặt thon, dễ thương, nhỏ nhắn.', { t: 'angle', angle: 'high' }),
  'b-camera-low-angle': info(undefined, 'Nhìn lên: dáng cao, tự tin, chân dài.', { t: 'angle', angle: 'low' }),
  'b-camera-worm-eye': info(undefined, 'Đặt máy sát đất, cực kỳ ấn tượng.', { t: 'angle', angle: 'worm' }),
  'b-camera-overhead': info(undefined, 'Thẳng từ trên xuống: nằm, ngồi bệt, flatlay.', { t: 'angle', angle: 'overhead' }),
  'b-camera-dutch': info(undefined, 'Nghiêng khung hình, tạo năng lượng và kịch tính.', { t: 'angle', angle: 'dutch' }),
  'b-camera-over-shoulder': info('OTS', 'Từ sau lưng, thấy điều nhân vật đang nhìn.', { t: 'angle', angle: 'ots' }),
  'b-camera-pov': info('POV', 'Người xem như đang ở cạnh nhân vật (kiểu “POV hẹn hò”).', { t: 'angle', angle: 'pov' }),
  'b-camera-foreground': info(undefined, 'Lá, kính hay vải mờ phía trước tạo chiều sâu.', { t: 'angle', angle: 'foreground' }),
  // Chuyển động máy (video)
  'b-camera-static': info('Tripod', 'Máy đứng yên, chỉ nhân vật chuyển động.', { t: 'move', move: 'static' }),
  'b-camera-push-in': info('Dolly in', 'Tiến chậm vào mặt, tăng cảm xúc.', { t: 'move', move: 'push' }),
  'b-camera-pull-back': info('Dolly out', 'Lùi ra dần, hé lộ bối cảnh.', { t: 'move', move: 'pull' }),
  'b-camera-pan': info('Pan', 'Xoay ngang theo nhân vật.', { t: 'move', move: 'pan' }),
  'b-camera-tilt-up': info('Tilt', 'Lia từ chân lên mặt, khoe trọn outfit.', { t: 'move', move: 'tilt' }),
  'b-camera-tracking': info('Tracking', 'Máy chạy song song khi nhân vật bước đi.', { t: 'move', move: 'track' }),
  'b-camera-orbit': info('Orbit', 'Vòng quanh nhân vật, rất điện ảnh.', { t: 'move', move: 'orbit' }),
  'b-camera-crane-up': info('Crane', 'Nâng máy lên cao, mở ra toàn cảnh.', { t: 'move', move: 'crane' }),
  'b-camera-handheld-follow': info('Handheld', 'Cầm tay đi theo sau, rung nhẹ tự nhiên.', { t: 'move', move: 'follow' }),
  'b-camera-vlog-walk': info('Vlog', 'Tự cầm máy vừa đi vừa nói chuyện.', { t: 'move', move: 'vlog' }),
  'b-camera-crash-zoom': info('Snap zoom', 'Zoom giật nhanh vào mặt để gây cười hoặc nhấn mạnh.', { t: 'move', move: 'zoom' }),
};

// ── Combination checks ───────────────────────────────────────────────

const id = (slug: string) => `b-camera-${slug}`;
const WIDE_LENSES = ['fisheye', '24mm-wide', 'phone-ultrawide'].map(id);
const FACE_SHOTS = ['shot-ecu', 'shot-cu'].map(id);
const BODY_SHOTS = ['shot-cowboy', 'shot-full', 'shot-wide'].map(id);
const ANGLE_SLUGS = ['eye-level', 'high-angle', 'low-angle', 'worm-eye', 'overhead', 'dutch', 'over-shoulder', 'pov', 'foreground'];
const DEVICE_IDS = new Set(Object.entries(CAMERA_INFO).filter(([, i]) => i.art.t === 'lens' || i.art.t === 'scene').map(([k]) => k));
const angleSlug = (v: string): string | null => (v.startsWith('b-camera-') && ANGLE_SLUGS.includes(v.slice(9)) ? v.slice(9) : null);

/**
 * Combinations that fight each other, as Vietnamese advice. Builtin ids only:
 * the owner's own items are taken as they are.
 */
export function cameraWarnings(ids: readonly string[]): string[] {
  const has = (x: string | string[]) => (Array.isArray(x) ? x.some((v) => ids.includes(v)) : ids.includes(x));
  const out: string[] = [];
  if (has(WIDE_LENSES) && has(FACE_SHOTS)) {
    out.push('Ống góc rộng chụp cận mặt làm mũi to, mặt méo. Cận mặt nên dùng ống 50–135mm.');
  }
  if (has(id('macro-face')) && ids.some((v) => v.startsWith(id('shot-')) && !FACE_SHOTS.includes(v))) {
    out.push('Macro chỉ hợp với Đặc tả hoặc Cận cảnh.');
  }
  if (has(id('iphone-front-selfie')) && has(BODY_SHOTS)) {
    out.push('Selfie cầm tay không lấy được cả người. Dùng Selfie gương hoặc Bạn chụp hộ.');
  }
  if (has(id('iphone-front-selfie')) && has(['over-shoulder', 'worm-eye', 'pov'].map(id))) {
    out.push('Selfie cầm tay chỉ chụp được trong tầm với của tay, không đặt máy ở góc này được.');
  }
  if (has(id('mirror-selfie')) && ids.some((v) => { const a = angleSlug(v); return a !== null && !['eye-level', 'high-angle', 'low-angle'].includes(a); })) {
    out.push('Selfie gương: góc máy là vị trí điện thoại trước gương, chỉ hợp Ngang tầm mắt, Góc cao hoặc Góc thấp.');
  }
  if (has(id('vlog-walk')) && ids.some((v) => DEVICE_IDS.has(v) && v !== id('iphone-front-selfie') && v !== id('phone-ultrawide'))) {
    out.push('Vlog cầm tay hợp với camera trước hoặc 0.5x của điện thoại.');
  }
  if (has(id('tilt-up')) && has([...FACE_SHOTS, id('shot-mcu')])) {
    out.push('Lia dọc lên cần thấy cả người: chọn Toàn thân hoặc Ba phần tư.');
  }
  return out;
}
