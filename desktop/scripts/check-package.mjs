import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const exe = await readFile(resolve(root, 'dist/GoodGPT-Windows.exe'));
assert.equal(exe.toString('ascii',0,2),'MZ','Windows artifact must be an executable');
const pe = exe.readUInt32LE(0x3c);
assert.equal(exe.toString('ascii',pe,pe+4),'PE\0\0','Windows PE header missing');
assert.ok(exe.length > 5_000_000, 'Expected embedded game sprites in the portable executable');
const zip = await readFile(resolve(root,'dist/GoodGPT-macOS.zip'));
const end = zip.length - 22;
assert.equal(zip.readUInt32LE(end),0x06054b50,'ZIP end record missing');
let offset = zip.readUInt32LE(end+16);
const entries = new Map();
for (let index=0; index<zip.readUInt16LE(end+10); index++) {
  assert.equal(zip.readUInt32LE(offset),0x02014b50,'ZIP directory entry invalid');
  const length=zip.readUInt16LE(offset+28), extra=zip.readUInt16LE(offset+30), comment=zip.readUInt16LE(offset+32);
  const name=zip.toString('utf8',offset+46,offset+46+length);
  entries.set(name,{mode:zip.readUInt32LE(offset+38)>>>16});
  offset+=46+length+extra+comment;
}
for (const path of ['Contents/Info.plist','Contents/MacOS/GoodGPT','Contents/Resources/GoodGPT.js','Contents/Resources/bag.png','Contents/Resources/treats.png']) {
  assert.ok(entries.has('GoodGPT.app/'+path),'Missing macOS package file: '+path);
}
assert.equal(entries.get('GoodGPT.app/Contents/MacOS/GoodGPT').mode,0o100755,'macOS launcher must be executable after extraction');
assert.ok(![...entries.keys()].some(name=>/\.pem$|node_modules|\.env$/i.test(name)));
console.log(`Desktop packages OK: Windows PE ${(exe.length/1024/1024).toFixed(1)} MiB, macOS ZIP ${(zip.length/1024/1024).toFixed(1)} MiB, launcher executable.`);
