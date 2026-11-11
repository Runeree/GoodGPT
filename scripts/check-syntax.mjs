import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
let count = 0;
for (const folder of ['src', 'scripts', 'tests']) {
  for (const file of await readdir(resolve(root, folder))) {
    if (!/\.m?js$/.test(file)) continue;
    const check = spawnSync(process.execPath, ['--check', resolve(root, folder, file)], { stdio: 'inherit' });
    if (check.status !== 0) process.exit(check.status || 1);
    count++;
  }
}
console.log(`Syntax OK: ${count} JavaScript modules.`);
