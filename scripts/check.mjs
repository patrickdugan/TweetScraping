import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
let failures = 0;
for (const folder of ['src', 'scripts', 'test']) {
  for (const file of fs.readdirSync(path.join(root, folder))) {
    if (!file.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(root, folder, file)], { encoding: 'utf8' });
    if (result.status !== 0) { console.error(result.stderr); failures++; }
  }
}
if (!failures) console.log('Syntax checks passed.');
process.exitCode = failures ? 1 : 0;
