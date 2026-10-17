// Task 80 verification. Preserve historical measurement reports; isolate outputs.
import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
const switches = [
  'TASK66_SWEEP','TASK68_REAL','TASK68_SPEED','TASK68_IMAGE_SWEEP','TASK69_BOXES',
  'TASK70_TABLES','TASK71_REAL','TASK72_REAL','TASK74_REAL','TASK74_UNITS',
  'TASK74_PREVIEW','TASK74_PATCH','TASK74_APPEARANCE','TASK74_TIMING','TASK74_WARM_TIMING',
  'TASK74_GROUPING','TASK74_PITCH','TASK74_GAPS','TASK74_POSITION','TASK74_POSITION_123',
  'TASK74_POSITION_CORPUS','TASK74_JUSTIFY_REVIEW','TASK74_JUSTIFY','TASK74_CHANGE5',
  'TASK76_REAL','TASK76_MEASURE','TASK76_FONT_COMPARE','TASK78_FONTS','TASK78_PROBE',
  'TASK78_PUBLISH','TASK78_MATCH','TASK78_VERSIONS','SQUEEZE_SCOPE',
  'TASK80_REAL','TASK80_MEASURE','SPACING_SCOPE',
];
await mkdir('tmp/task80/checks', { recursive: true });
const log = await open('tmp/task80/checks/all-checks.log', 'w');
const env = { ...process.env, TASK78_OUTPUT: 'tmp/task80/task78-recheck' };
for (const key of switches) env[key] = '1';
process.stdout.write(`Enabled ${switches.length} real-PDF switches. Log: tmp/task80/checks/all-checks.log\n`);
const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs','run','--maxWorkers=2','--minWorkers=1','--reporter=json','--outputFile=tmp/task80/checks/all-checks.json'], { env, stdio: ['ignore',log.fd,log.fd] });
child.on('error', error => { process.stderr.write(String(error)); process.exitCode = 1; });
child.on('exit', async code => { await log.close(); process.stdout.write(`Full run exited ${code}; JSON: tmp/task80/checks/all-checks.json\n`); process.exitCode = code ?? 1; });
