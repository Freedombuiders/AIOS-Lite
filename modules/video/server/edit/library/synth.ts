// SFX synthesised with ffmpeg lavfi: nothing downloaded, nothing to license beyond our own recipe (CC0).
import { childPath, findBin } from '../../bin.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SYNTH_LICENSE = 'tự tổng hợp (CC0)';

export interface SynthRecipe {
  /** Builtin sfx slug (catalog/assets.ts), e.g. "whoosh". */
  slug: string;
  /** Vietnamese name of the recipe ("vut" in the plan). */
  recipe: string;
  durationSec: number;
  /** Complete ffmpeg input args (lavfi sources) + filter graph. */
  args: string[];
}

const R = 44100;

const aeval = (expr: string, d: number) => ['-f', 'lavfi', '-i', `aevalsrc='${expr}':d=${d}:s=${R}`];
const noise = (d: number, color: 'white' | 'pink', amp = 0.9) => ['-f', 'lavfi', '-i', `anoisesrc=d=${d}:c=${color}:r=${R}:a=${amp}`];

export const SYNTH_RECIPES: SynthRecipe[] = [
  {
    // vút: pink noise whose low band fades out while the high band swells and fades.
    slug: 'whoosh', recipe: 'vut', durationSec: 0.9,
    args: [...noise(0.9, 'pink'), '-filter_complex',
      "[0:a]asplit=2[a][b];"
      + "[a]lowpass=f=700,volume='pow(sin(PI*min(t/0.9,1)),2)':eval=frame[lo];"
      + "[b]highpass=f=2500,volume='pow(sin(PI*min(max((t-0.15)/0.75,0),1)),3)':eval=frame[hi];"
      + '[lo][hi]amix=inputs=2:normalize=0,afade=t=in:d=0.05,afade=t=out:st=0.6:d=0.3,volume=1.8,alimiter=limit=0.9'],
  },
  {
    // dâng lên: rising chirp plus a swelling hiss.
    slug: 'riser', recipe: 'dang-len', durationSec: 2.2,
    args: [...aeval('0.45*sin(2*PI*(200*t+(2200*t*t)/(2*2.2)))*pow(t/2.2,1.5)', 2.2), ...noise(2.2, 'white', 0.8), '-filter_complex',
      "[1:a]highpass=f=3500,volume='pow(t/2.2,2.2)*0.55':eval=frame[n];"
      + '[0:a][n]amix=inputs=2:normalize=0,afade=t=out:st=2.1:d=0.1,volume=1.6,alimiter=limit=0.9'],
  },
  {
    // sub drop: a sine sliding from 90 Hz to ~38 Hz with a soft attack click.
    slug: 'sub-drop', recipe: 'sub-drop', durationSec: 1.5,
    args: [...aeval('0.95*sin(2*PI*(90*t-(52*t*t)/(2*1.5)))*exp(-1.6*t)*min(t*200,1)', 1.5), '-af', 'lowpass=f=140,volume=1.5,alimiter=limit=0.95,afade=t=out:st=1.3:d=0.2'],
  },
  {
    // ding: a small bell, three decaying partials.
    slug: 'ding', recipe: 'ding', durationSec: 1.4,
    args: [...aeval('0.5*sin(2*PI*1318.5*t)*exp(-4*t)+0.25*sin(2*PI*2637*t)*exp(-6*t)+0.12*sin(2*PI*3960*t)*exp(-9*t)', 1.4), '-af', 'volume=1.4,alimiter=limit=0.9,afade=t=out:st=1.2:d=0.2'],
  },
  {
    // tích tắc: tick and a lower tock every half second.
    slug: 'tick-tock', recipe: 'tich-tac', durationSec: 2,
    args: [...aeval('0.8*sin(2*PI*if(lt(mod(t,1),0.5),2000,1500)*t)*exp(-90*mod(t,0.5))', 2), '-af', 'highpass=f=400,volume=1.9,alimiter=limit=0.85'],
  },
  {
    // bụp: a short sine whose pitch falls fast.
    slug: 'pop', recipe: 'bup', durationSec: 0.3,
    args: [...aeval('0.9*sin(2*PI*(300*t+900*(1-exp(-30*t))/30))*exp(-18*t)', 0.3), '-af', 'volume=1.3,alimiter=limit=0.9'],
  },
  {
    // glitch: bit-crushed noise gated in stutters plus a jumping tone.
    slug: 'glitch', recipe: 'glitch', durationSec: 0.7,
    args: [...noise(0.7, 'white', 0.8), ...aeval('0.4*sin(2*PI*(1000+3000*mod(t*17,1))*t)*if(lt(mod(t*13,1),0.5),1,0)', 0.7), '-filter_complex',
      "[0:a]acrusher=bits=4:mode=log:aa=0,volume='if(lt(mod(t*23,1),0.4),1,0)':eval=frame[n];"
      + '[n][1:a]amix=inputs=2:normalize=0,afade=t=out:st=0.55:d=0.15,volume=1.0,alimiter=limit=0.8'],
  },
  {
    // bong bóng: three bubbles with rising pitch.
    slug: 'bubble', recipe: 'bong-bong', durationSec: 0.9,
    args: [...aeval('st(0,mod(t,0.3));0.7*sin(2*PI*(500*ld(0)+3500*ld(0)*ld(0)))*exp(-14*ld(0))', 0.9), '-af', 'volume=1.3,alimiter=limit=0.9,afade=t=out:st=0.8:d=0.1'],
  },
];

function runFfmpeg(args: string[], timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(findBin('ffmpeg') ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: timeoutMs, env: { ...process.env, PATH: childPath() } }, (err, _out, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).slice(0, 300)));
      else resolve();
    });
  });
}

/** Renders one recipe to an mp3 file. */
export async function synthesize(recipe: SynthRecipe, outFile: string): Promise<void> {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await runFfmpeg([...recipe.args, '-ac', '2', '-ar', String(R), '-c:a', 'libmp3lame', '-q:a', '3', outFile]);
}

/** Typing: eight key clicks (a CC0 click sample) at human-looking, uneven gaps. */
const TYPING_AT = [0, 0.17, 0.29, 0.52, 0.63, 0.91, 1.05, 1.34];

export async function synthesizeTyping(clickFiles: string[], outFile: string): Promise<void> {
  if (clickFiles.length === 0) throw new Error('Thiếu mẫu click để ghép tiếng gõ phím.');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const inputs = TYPING_AT.flatMap((_, i) => ['-i', clickFiles[i % clickFiles.length]]);
  const delays = TYPING_AT.map((t, i) => `[${i}:a]aresample=${R},aformat=channel_layouts=stereo,adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)}[k${i}]`).join(';');
  const mix = `${TYPING_AT.map((_, i) => `[k${i}]`).join('')}amix=inputs=${TYPING_AT.length}:normalize=0,volume=1.2,alimiter=limit=0.85,apad=pad_dur=0.2,atrim=0:1.7`;
  await runFfmpeg([...inputs, '-filter_complex', `${delays};${mix}`, '-ac', '2', '-ar', String(R), '-c:a', 'libmp3lame', '-q:a', '3', outFile]);
}

/** Converts a sample to mp3 (used for the Kenney .ogg files, so Safari previews work). */
export async function convertToMp3(src: string, outFile: string): Promise<void> {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await runFfmpeg(['-i', src, '-vn', '-ac', '2', '-ar', String(R), '-c:a', 'libmp3lame', '-q:a', '3', outFile]);
}
