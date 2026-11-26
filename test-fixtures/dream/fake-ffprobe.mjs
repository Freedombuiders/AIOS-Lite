#!/usr/bin/env node
// Fake ffprobe for modules/dream tests: prints a length. FAKE_FFPROBE_MODE=fail exits 1.
if (process.env.FAKE_FFPROBE_MODE === 'fail') { process.stderr.write('Invalid data found when processing input\n'); process.exit(1); }
process.stdout.write(`${process.env.FAKE_DURATION ?? '31.0'}\n`);
