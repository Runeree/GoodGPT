import { mkdir, copyFile, access, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'extension');
await mkdir(resolve(output, 'assets'), { recursive: true });
for (const name of ['bag.png', 'treats.png', 'icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png']) {
  await access(resolve(root, 'assets', name));
  await copyFile(resolve(root, 'assets', name), resolve(output, 'assets', name));
}
for (const name of ['manifest.json', 'popup.html', 'popup.css', 'popup.js']) await copyFile(resolve(root, 'src', name), resolve(output, name));
// Fixed dependency graph: three local modules, no external imports or runtime loader.
const modules = [];
for (const name of ['scene.js', 'chat-bridge.js', 'content.js']) {
  const source = await readFile(resolve(root, 'src', name), 'utf8');
  modules.push(`// ${name}\n` + source.replace(/^import\s+[^;]+;\s*$/gm, '').replace(/^export\s+/gm, ''));
}
await writeFile(resolve(output,'content.js'), '/* GoodGPT — all runtime code is local. */\n(() => {\n"use strict";\n' + modules.join('\n\n') + '\n})();\n');
await copyFile(resolve(root, 'INSTALL.txt'), resolve(output, 'INSTALL.txt'));
await copyFile(resolve(root, 'LICENSE'), resolve(output, 'LICENSE.txt'));
await writeFile(resolve(output, 'ASSETS.txt'), 'Original bag and sweets game sprites generated for this project with OpenAI imagegen. No third-party game asset packs. Runtime code: MIT (see LICENSE.txt).\n');
console.log('GoodGPT built in extension/ — ready to load unpacked.');
