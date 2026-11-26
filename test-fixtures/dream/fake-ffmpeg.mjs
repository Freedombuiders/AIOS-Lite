#!/usr/bin/env node
// Fake ffmpeg for modules/dream tests.
// FAKE_FFMPEG_MODE: ok | fail | hang | failframes
//   scene pass (args contain showinfo): prints showinfo lines with pts_time to stderr
//   frame pass (output hook%02d.jpg): writes four tiny jpg files
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const mode = process.env.FAKE_FFMPEG_MODE ?? 'ok';
if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'fail') { process.stderr.write('Conversion failed!\n'); process.exit(1); }
else if (args.some((a) => a.includes('showinfo'))) {
  const times = (process.env.FAKE_CUTS ?? '0.8,1.6,2.4,5,9.5,14,18,22,26,29').split(',').map(Number);
  for (const t of times) process.stderr.write(`[Parsed_showinfo_1 @ 0x1] n:   0 pts:  ${Math.round(t * 1000)} pts_time:${t} duration: 1 fmt:yuv420p\n`);
  process.exit(0);
} else {
  if (mode === 'failframes') { process.stderr.write('Error while filtering\n'); process.exit(1); }
  const out = args[args.length - 1];
  for (let i = 1; i <= 4; i++) fs.writeFileSync(path.join(path.dirname(out), `hook${String(i).padStart(2, '0')}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
}
