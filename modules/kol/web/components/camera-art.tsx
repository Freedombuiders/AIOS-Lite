// Schematic diagrams for camera library items: field of view per focal
// length, what each shot size keeps in frame, where the camera sits for each
// angle, and how it moves. Pure SVG in theme colours; no text inside.

import type { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';
import type { CameraArtSpec, ShotSize } from '@modules/kol/web/lib/kol-camera';

const LINE = 'var(--color-accent)';
const FILL = 'color-mix(in srgb, var(--color-accent) 20%, var(--color-card))';
const DARK = 'color-mix(in srgb, var(--color-accent) 48%, var(--color-card))';
const CONE = 'color-mix(in srgb, var(--color-accent) 14%, transparent)';
const GROUND = 'var(--color-border-strong)';
const FAINT = 'var(--color-text-faint)';
const PAPER = 'var(--color-card)';

const outline = { stroke: LINE, 'stroke-width': 1.4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' } as const;
/** For shapes drawn inside a scaled group: the stroke stays 1.5px on screen. */
const fixed = { ...outline, 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' } as const;
const dashed = { stroke: LINE, 'stroke-width': 1.1, 'stroke-dasharray': '2 2.4', fill: 'none', opacity: 0.75 } as const;

function Frame({ viewBox = '0 0 120 80', children }: { viewBox?: string; children: ComponentChildren }) {
  return (
    <svg viewBox={viewBox} preserveAspectRatio="xMidYMid slice" class="block w-full h-full" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

// ── Primitives ───────────────────────────────────────────────────────

/** Standing person, unit height, centred on x; `face` adds eyes, brows, nose and lips. */
function Person({ x, y, h, ghost, face, fill = FILL }: { x: number; y: number; h: number; ghost?: boolean; face?: boolean; fill?: string }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${h})`} opacity={ghost ? 0.4 : 1}>
      <path d="M-.11 .55 L.11 .55 L.085 1 L.02 1 L0 .66 L-.02 1 L-.085 1 Z" fill={fill} {...fixed} />
      <path d="M-.03 .14 L.03 .14 L.035 .22 L-.035 .22 Z" fill={fill} {...fixed} />
      <path d="M-.15 .31 Q-.15 .2 -.05 .2 L.05 .2 Q.15 .2 .15 .31 L.13 .58 L-.13 .58 Z" fill={fill} {...fixed} />
      <circle cx="0" cy=".085" r=".085" fill={fill} {...fixed} />
      {face && (
        <g>
          <path d="M-.05 .063 Q-.032 .053 -.013 .06 M.05 .063 Q.032 .053 .013 .06" fill="none" {...fixed} />
          <ellipse cx="-.031" cy=".08" rx=".016" ry=".0075" fill={PAPER} {...fixed} />
          <ellipse cx=".031" cy=".08" rx=".016" ry=".0075" fill={PAPER} {...fixed} />
          <circle cx="-.031" cy=".08" r=".0055" fill={LINE} />
          <circle cx=".031" cy=".08" r=".0055" fill={LINE} />
          <path d="M.002 .088 L-.006 .106 L.006 .107" fill="none" stroke={FAINT} stroke-width="1.2" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
          <path d="M-.022 .127 Q0 .14 .022 .127 Q0 .12 -.022 .127 Z" fill={LINE} opacity=".7" />
        </g>
      )}
    </g>
  );
}

/** Camera body pointing along +x, centred on (x, y). */
function Camera({ x, y, rot = 0, lens = 6, body = 'camera' }: { x: number; y: number; rot?: number; lens?: number; body?: 'camera' | 'cine' | 'mf' }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`}>
      {body === 'mf' ? (
        <>
          <rect x="-8" y="-12" width="13" height="4.5" rx="1" fill={FILL} {...outline} />
          <rect x="-8" y="-7.5" width="13" height="15" rx="1.5" fill={FILL} {...outline} />
        </>
      ) : body === 'cine' ? (
        <>
          <path d="M-9 -6 L-9 -10 L1 -10 L1 -6" fill="none" {...outline} />
          <rect x="-12" y="-6" width="17" height="12" rx="1.5" fill={FILL} {...outline} />
        </>
      ) : (
        <>
          <path d="M-5 -6 L-3.5 -9 L1.5 -9 L3 -6" fill={FILL} {...outline} />
          <rect x="-9" y="-6" width="14" height="12" rx="2" fill={FILL} {...outline} />
        </>
      )}
      <rect x="5" y="-4.5" width={lens} height="9" rx="1.2" fill={FILL} {...outline} />
      {body === 'cine' && <path d={`M${5 + lens} -4 L${10 + lens} -8 L${10 + lens} 8 L${5 + lens} 4 Z`} fill={FILL} {...outline} />}
    </g>
  );
}

function Phone({ x, y, rot = 0 }: { x: number; y: number; rot?: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`}>
      <rect x="-4" y="-7" width="8" height="14" rx="1.8" fill={FILL} {...outline} />
      <circle cx="-1.3" cy="-4.2" r=".9" fill={LINE} />
      <circle cx="1.1" cy="-4.2" r=".9" fill={LINE} />
    </g>
  );
}

/** Line with a filled arrowhead at its end; `d` is any path, `tip` the end point and heading in degrees. */
function Arrow({ d, tip }: { d: string; tip: [number, number, number] }) {
  const [x, y, deg] = tip;
  return (
    <g>
      <path d={d} fill="none" stroke={LINE} stroke-width="1.6" stroke-linecap="round" />
      <path d="M0 0 L-5 -3 L-5 3 Z" fill={LINE} transform={`translate(${x} ${y}) rotate(${deg})`} />
    </g>
  );
}

const Ground = ({ y = 72 }: { y?: number }) => <line x1="0" x2="120" y1={y} y2={y} stroke={GROUND} stroke-width="1" />;
const deg = (dx: number, dy: number) => (Math.atan2(dy, dx) * 180) / Math.PI;

// ── Families ─────────────────────────────────────────────────────────

/** Field of view: the lens barrel grows with focal length, the cone narrows. */
function LensArt({ fov, body = 'camera', near, fisheye }: Extract<CameraArtSpec, { t: 'lens' }>) {
  const cy = 30;
  const lens = body === 'phone' ? 0 : Math.min(18, 3 + 260 / fov);
  const apex = body === 'phone' ? 25 : 25 + lens + (body === 'cine' ? 5 : 0);
  const reach = 125 - apex;
  const half = Math.tan(((Math.min(fov, 176) / 2) * Math.PI) / 180) * reach;
  return (
    <Frame>
      <Ground />
      <path d={`M${apex} ${cy} L125 ${cy - half} L125 ${cy + half} Z`} fill={CONE} stroke={LINE} stroke-width="1" stroke-dasharray="3 2.5" stroke-opacity=".7" />
      {fisheye && [16, 30, 46].map((r) => (
        <path key={r} d={`M${apex} ${cy - r} A${r} ${r} 0 0 1 ${apex} ${cy + r}`} fill="none" stroke={LINE} stroke-width=".9" opacity=".45" />
      ))}
      {near ? (
        <g transform="translate(86 30)">
          <path d="M-20 0 Q0 -15 20 0 Q0 15 -20 0 Z" fill={PAPER} {...outline} />
          <circle r="7.5" fill={FILL} {...outline} />
          <circle r="3.4" fill={LINE} />
          <path d="M-18 -9 L-15 -12 M-9 -13 L-8 -17 M0 -14.5 L0 -19 M9 -13 L8 -17 M18 -9 L15 -12" stroke={LINE} stroke-width="1.1" stroke-linecap="round" />
        </g>
      ) : (
        <Person x={98} y={22} h={50} face />
      )}
      {body === 'phone'
        ? <Phone x={20} y={cy} />
        : <Camera x={20 - (body === 'cine' ? 2 : 0)} y={cy} lens={lens} body={body} />}
      {fisheye && <path d={`M${apex - 1} ${cy - 5} A6 6 0 0 1 ${apex - 1} ${cy + 5}`} fill={FILL} {...outline} />}
    </Frame>
  );
}

/** Shot sizes as crops of one figure: the viewBox is the frame. */
const SHOT_FRAME: Record<ShotSize, [top: number, height: number]> = {
  ecu: [0.045, 0.1],
  cu: [-0.015, 0.22],
  mcu: [-0.03, 0.4],
  ms: [-0.04, 0.66],
  cowboy: [-0.05, 0.86],
  full: [-0.08, 1.16],
  wide: [-1.05, 2.3],
};

function ShotArt({ shot }: { shot: ShotSize }) {
  const [top, h] = SHOT_FRAME[shot];
  const w = h * 1.5;
  return (
    <div class="relative w-full h-full">
      <Frame viewBox={`${-w / 2} ${top} ${w} ${h}`}>
        <rect x={-w / 2} y={top} width={w} height={h} fill="color-mix(in srgb, var(--color-accent) 5%, var(--color-elevated))" />
        {shot === 'wide' && (
          <g>
            <circle cx="-1.25" cy="-.55" r=".16" fill="none" {...fixed} />
            <path d="M-1.95 1 L-1.65 .4 L-1.42 .66 L-1.2 .32 L-.95 1 Z M.95 1 L1.25 .5 L1.45 .68 L1.65 .25 L1.95 1 Z" fill={FILL} {...fixed} />
          </g>
        )}
        <line x1="-3" x2="3" y1="1" y2="1" stroke={GROUND} stroke-width="1" vector-effect="non-scaling-stroke" />
        <Person x={0} y={0} h={1} face={shot === 'ecu' || shot === 'cu' || shot === 'mcu'} />
      </Frame>
      <Brackets />
    </div>
  );
}

/** Viewfinder corner marks over a shot diagram. */
function Brackets() {
  const c = 'M4 13 L4 4 L13 4 M107 4 L116 4 L116 13 M116 67 L116 76 L107 76 M13 76 L4 76 L4 67';
  return (
    <svg viewBox="0 0 120 80" preserveAspectRatio="none" class="absolute inset-0 w-full h-full" aria-hidden="true" focusable="false">
      <path d={c} fill="none" stroke={LINE} stroke-width="1.6" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    </svg>
  );
}

/** The viewer's own forearm and hand reaching into the frame from below (POV). */
function PovHand({ x, y, rot }: { x: number; y: number; rot: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`}>
      <rect x="-44" y="-5.5" width="44" height="11" rx="5.5" fill={FILL} {...outline} />
      <ellipse cx="4" cy="0" rx="7.5" ry="6.5" fill={FILL} {...outline} />
      <ellipse cx="1" cy="-6.5" rx="3.6" ry="2.4" transform="rotate(-25 1 -6.5)" fill={FILL} {...outline} />
    </g>
  );
}

/** Side view: where the camera sits relative to the face. */
function AngleArt({ angle }: Extract<CameraArtSpec, { t: 'angle' }>) {
  const blurId = useId();
  const face: [number, number] = [90, 28];
  const aim = (x: number, y: number, lens = 6) => (
    <>
      <line x1={x} y1={y} x2={face[0]} y2={face[1]} {...dashed} />
      <Camera x={x} y={y} lens={lens} rot={deg(face[0] - x, face[1] - y)} />
    </>
  );
  const subject = <Person x={90} y={24} h={48} face />;
  switch (angle) {
    case 'eye': return <Frame><Ground />{subject}{aim(30, 28)}</Frame>;
    case 'high': return <Frame><Ground />{subject}{aim(36, 12)}</Frame>;
    case 'low': return <Frame><Ground />{subject}{aim(34, 62)}</Frame>;
    case 'worm': return <Frame><Ground />{subject}{aim(52, 66.5, 5)}</Frame>;
    case 'overhead': return (
      <Frame>
        <Ground />
        <Person x={60} y={24} h={48} face />
        <line x1="60" y1="21" x2="60" y2="24" {...dashed} />
        <Camera x={60} y={10} rot={90} lens={5} />
      </Frame>
    );
    case 'dutch': return (
      <Frame>
        <g transform="rotate(-14 60 40)">
          <rect x="22" y="10" width="76" height="60" rx="3" fill="none" stroke={LINE} stroke-width="1.4" />
          <line x1="22" x2="98" y1="60" y2="60" stroke={GROUND} stroke-width="1" />
          <Person x={60} y={18} h={42} face />
        </g>
      </Frame>
    );
    case 'ots': return (
      <Frame>
        <path d="M66 50 L78 38 L88 46 L100 32 L122 50" fill={FILL} {...outline} />
        <line x1="54" x2="120" y1="50" y2="50" stroke={GROUND} stroke-width="1" />
        <circle cx="100" cy="18" r="6" fill="none" {...outline} />
        <path d="M-4 82 L-2 66 Q3 54 22 52 L44 52 Q62 54 68 66 L70 82 Z" fill={DARK} {...outline} />
        <circle cx="33" cy="40" r="13" fill={DARK} {...outline} />
      </Frame>
    );
    case 'pov': return (
      <Frame>
        <Ground />
        <Person x={60} y={16} h={56} face />
        <PovHand x={34} y={63} rot={-38} />
        <g transform="translate(120 0) scale(-1 1)"><PovHand x={34} y={63} rot={-38} /></g>
      </Frame>
    );
    case 'foreground': return (
      <Frame>
        <defs><filter id={blurId} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" /></filter></defs>
        <Ground />
        <Person x={64} y={18} h={54} face />
        <g filter={`url(#${blurId})`} fill={LINE} opacity=".32">
          <ellipse cx="6" cy="28" rx="16" ry="22" />
          <ellipse cx="14" cy="72" rx="18" ry="13" />
          <ellipse cx="116" cy="14" rx="12" ry="17" />
        </g>
      </Frame>
    );
  }
}

/** How the camera moves: camera glyph, subject and a motion arrow. */
function MoveArt({ move }: Extract<CameraArtSpec, { t: 'move' }>) {
  const subject = <Person x={92} y={26} h={46} face />;
  switch (move) {
    case 'static': return (
      <Frame>
        <Ground />{subject}
        <path d="M34 45 L24 72 M34 45 L44 72 M34 45 L34 72" fill="none" {...outline} />
        <line x1="34" y1="38" x2="92" y2="30" {...dashed} />
        <Camera x={34} y={38} rot={-8} />
      </Frame>
    );
    case 'push': return (
      <Frame><Ground />{subject}<Camera x={22} y={34} rot={-4} /><Arrow d="M40 34 L64 32" tip={[69, 31.6, -5]} /></Frame>
    );
    case 'pull': return (
      <Frame><Ground />{subject}<Camera x={52} y={34} rot={-6} /><Arrow d="M38 34 L16 35" tip={[11, 35.3, 177]} /></Frame>
    );
    case 'pan': return (
      <Frame>
        <Ground />
        <Person x={18} y={36} h={36} ghost />
        <Person x={102} y={36} h={36} face />
        <path d="M56 58 L48 72 M56 58 L64 72" fill="none" {...outline} />
        <Camera x={56} y={52} lens={5} />
        <Arrow d="M38 30 Q60 14 80 30" tip={[84, 33, 40]} />
      </Frame>
    );
    case 'tilt': return (
      <Frame>
        <Ground />
        <Person x={92} y={18} h={54} face />
        <line x1="38" y1="44" x2="90" y2="70" {...dashed} opacity=".35" />
        <line x1="38" y1="44" x2="90" y2="23" {...dashed} />
        <Camera x={32} y={44} rot={-12} />
        <Arrow d="M62 66 Q54 46 62 28" tip={[64, 24, -66]} />
      </Frame>
    );
    case 'track': return (
      <Frame>
        <Person x={74} y={14} h={40} face />
        <Arrow d="M56 58 L90 58" tip={[95, 58, 0]} />
        <Camera x={30} y={66} rot={-30} lens={5} />
        <Arrow d="M42 75 L76 75" tip={[81, 75, 0]} />
      </Frame>
    );
    case 'orbit': return (
      <Frame>
        <ellipse cx="62" cy="58" rx="44" ry="13" {...dashed} />
        <Person x={62} y={14} h={48} face />
        <path d="M18 58 A44 13 0 0 0 62 71" fill="none" stroke={LINE} stroke-width="1.6" stroke-linecap="round" />
        <path d="M0 0 L-5 -3 L-5 3 Z" fill={LINE} transform="translate(66 70.9) rotate(-2)" />
        <Camera x={18} y={56} rot={-20} lens={5} />
      </Frame>
    );
    case 'crane': return (
      <Frame>
        <Ground />{subject}
        <path d="M24 72 L24 60 M14 64 L48 26" fill="none" {...outline} />
        <circle cx="24" cy="60" r="2" fill={LINE} />
        <Camera x={50} y={20} rot={18} lens={5} />
        <Arrow d="M66 54 L66 22" tip={[66, 17, -90]} />
      </Frame>
    );
    case 'follow': return (
      <Frame>
        <Ground />{subject}
        <Camera x={26} y={38} />
        <Arrow d="M42 52 q3.5 -4 7 0 t7 0 t7 0 t7 0" tip={[74, 52, 0]} />
      </Frame>
    );
    case 'vlog': return (
      <Frame>
        <Ground />
        <Person x={86} y={20} h={52} face />
        <path d="M79 34 L60 30 L50 26" fill="none" stroke={LINE} stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        <Phone x={47} y={25} rot={-8} />
        <Arrow d="M30 66 L58 66" tip={[63, 66, 0]} />
      </Frame>
    );
    case 'zoom': return (
      <Frame>
        <Ground />{subject}
        <Camera x={20} y={34} />
        <path d="M80 18 L80 14 L84 14 M100 14 L104 14 L104 18 M104 40 L104 44 L100 44 M84 44 L80 44 L80 40" fill="none" stroke={LINE} stroke-width="1.6" stroke-linecap="round" />
        <path d="M36 30 L76 16 M36 38 L76 44" {...dashed} />
      </Frame>
    );
  }
}

/** Phone situations: arm's-length selfie, mirror, a friend shooting. */
function SceneArt({ scene }: Extract<CameraArtSpec, { t: 'scene' }>) {
  switch (scene) {
    case 'selfie': return (
      <Frame>
        <Person x={84} y={12} h={104} face />
        <path d="M70 42 L52 38 L38 30" fill="none" stroke={LINE} stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
        <line x1="38" y1="28" x2="84" y2="21" {...dashed} />
        <Phone x={34} y={28} rot={-12} />
      </Frame>
    );
    case 'mirror': return (
      <Frame>
        <rect x="52" y="4" width="56" height="74" rx="4" fill="color-mix(in srgb, var(--color-accent) 6%, transparent)" {...outline} />
        <path d="M96 10 L102 16 M92 10 L102 20" stroke={LINE} stroke-width="1" opacity=".55" stroke-linecap="round" />
        <Person x={80} y={12} h={62} />
        <Phone x={80} y={19} />
        <line x1="12" x2="52" y1="74" y2="74" stroke={GROUND} stroke-width="1" />
      </Frame>
    );
    case 'friend': return (
      <Frame>
        <Ground />
        <Person x={24} y={32} h={40} ghost />
        <path d="M28 46 L34 38" fill="none" stroke={LINE} stroke-width="2" stroke-linecap="round" opacity=".6" />
        <Phone x={36} y={34} rot={90} />
        <line x1="42" y1="34" x2="92" y2="28" {...dashed} />
        <Person x={92} y={24} h={48} face />
      </Frame>
    );
  }
}

function Drawing({ spec }: { spec: CameraArtSpec }) {
  switch (spec.t) {
    case 'lens': return <LensArt {...spec} />;
    case 'shot': return <ShotArt shot={spec.shot} />;
    case 'angle': return <AngleArt {...spec} />;
    case 'move': return <MoveArt {...spec} />;
    case 'scene': return <SceneArt {...spec} />;
  }
}

/** The 3:2 diagram, centred in its box (a square tile shows it letterboxed, never cropped). */
export function CameraDiagram({ spec }: { spec: CameraArtSpec }) {
  return (
    <span class="w-full h-full flex items-center justify-center">
      <span class="relative block w-full max-h-full aspect-[3/2]"><Drawing spec={spec} /></span>
    </span>
  );
}
