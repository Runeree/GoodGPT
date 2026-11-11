import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../extension/', import.meta.url)));
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3, 'Expected Manifest V3');
assert.equal(manifest.name, 'GoodGPT');
assert.deepEqual(manifest.permissions || [], ['storage'], 'Only the storage permission is needed');
assert.deepEqual(manifest.host_permissions || [], [], 'Content script matches are sufficient');
const expectedMatches = ['https://chatgpt.com/*', 'https://chat.openai.com/*'].sort();
assert.deepEqual([...new Set(manifest.content_scripts.flatMap(item => item.matches))].sort(), expectedMatches, 'Limit injection to ChatGPT domains');
assert.ok(manifest.content_scripts.every(item => !item.all_frames), 'Do not inject into subframes');
assert.ok(manifest.web_accessible_resources?.length, 'Declare packaged sprite assets');

async function verifyFile(relative) {
  assert.ok(!relative.startsWith('/') && !relative.includes('..'), `Unsafe package path: ${relative}`);
  const path = resolve(root, relative);
  assert.ok(path.startsWith(root + sep));
  assert.ok((await stat(path)).isFile(), `Missing file: ${relative}`);
  assert.ok((await stat(path)).size > 0, `Empty file: ${relative}`);
  return path;
}

for (const script of manifest.content_scripts) {
  for (const file of [...(script.js || []), ...(script.css || [])]) {
    const path = await verifyFile(file);
    if (file.endsWith('.js')) {
      const source = await readFile(path, 'utf8');
      assert.ok(!/\bimport\s*(?:[^;]*?from\s*)?["']https?:/u.test(source), 'All executable code must be local');
      assert.ok(!/\beval\s*\(/u.test(source), 'Content script must not use eval');
    }
  }
}
if (manifest.action?.default_popup) await verifyFile(manifest.action.default_popup);
for (const icon of Object.values(manifest.icons || {})) await verifyFile(icon);
for (const group of manifest.web_accessible_resources) {
  assert.deepEqual([...group.matches].sort(), expectedMatches, 'Restrict accessible assets to ChatGPT domains');
  for (const resource of group.resources) {
    if (resource.endsWith('/*')) {
      const directory = resolve(root, resource.slice(0, -2));
      assert.ok(directory.startsWith(root + sep));
      assert.ok((await readdir(directory)).length > 0, `Empty asset folder: ${resource}`);
    } else await verifyFile(resource);
  }
}
const all = await readdir(root, {recursive:true});
assert.ok(!all.some(file => /(?:^|[\\/])(?:node_modules|\.env|tests)(?:[\\/]|$)/u.test(file)), 'Ship only extension runtime files');
console.log(`Package OK: Manifest V3, storage only, ${all.length} entries, local runtime assets.`);
