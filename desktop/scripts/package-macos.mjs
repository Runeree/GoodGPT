import { mkdir, readFile, writeFile, copyFile, readdir, stat, chmod } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import './icons.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = resolve(root, 'dist');
const app = resolve(dist, 'GoodGPT.app');
await mkdir(resolve(app, 'Contents/MacOS'), { recursive: true });
await mkdir(resolve(app, 'Contents/Resources'), { recursive: true });
for (const [source, target] of [
  ['desktop/macos/Info.plist', 'Contents/Info.plist'],
  ['desktop/macos/GoodGPT', 'Contents/MacOS/GoodGPT'],
  ['desktop/macos/GoodGPT.js', 'Contents/Resources/GoodGPT.js'],
  ['desktop/resources/GoodGPT.icns', 'Contents/Resources/GoodGPT.icns'],
  ['assets/bag.png', 'Contents/Resources/bag.png'],
  ['assets/treats.png', 'Contents/Resources/treats.png'],
  ['LICENSE', 'Contents/Resources/LICENSE.txt'],
]) await copyFile(resolve(root, source), resolve(app, target));
const launcherPath = resolve(app, 'Contents/MacOS/GoodGPT');
await writeFile(launcherPath, (await readFile(launcherPath, 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
await chmod(resolve(app, 'Contents/MacOS/GoodGPT'), 0o755);

// Create a ZIP with Unix executable permissions even when packaged on Windows.
// Finder/Archive Utility then restores the .app launcher as executable.
const table = Array.from({length:256}, (_, index) => {
  let value = index;
  for (let bit=0; bit<8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = data => {
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const entries = [];
async function walk(folder) {
  for (const entry of await readdir(folder, {withFileTypes:true})) {
    const path = resolve(folder, entry.name);
    const name = relative(dist, path).split(sep).join('/');
    if (entry.isDirectory()) { entries.push({name:name+'/',data:Buffer.alloc(0),mode:0o40755}); await walk(path); }
    else entries.push({name,data:await readFile(path),mode:name.endsWith('/MacOS/GoodGPT')?0o100755:0o100644});
  }
}
entries.push({name:'GoodGPT.app/',data:Buffer.alloc(0),mode:0o40755});
await walk(app);
entries.push({name:'ПРОЧИТАЙТЕ.txt',data:await readFile(resolve(root,'desktop/macos/README.md')),mode:0o100644});
const chunks=[], central=[];
let offset=0;
// Stable archive timestamp; file names are UTF-8, no platform-specific paths.
const date=((2026-1980)<<9)|(11<<5)|11, time=0;
for (const entry of entries) {
  const filename=Buffer.from(entry.name,'utf8'), compressed=deflateRawSync(entry.data), crc=crc32(entry.data);
  const local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20,4); local.writeUInt16LE(0x800,6);
  local.writeUInt16LE(8,8); local.writeUInt16LE(time,10); local.writeUInt16LE(date,12);
  local.writeUInt32LE(crc,14); local.writeUInt32LE(compressed.length,18); local.writeUInt32LE(entry.data.length,22); local.writeUInt16LE(filename.length,26);
  chunks.push(local,filename,compressed);
  const header=Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50); header.writeUInt16LE(0x0314,4); header.writeUInt16LE(20,6); header.writeUInt16LE(0x800,8);
  header.writeUInt16LE(8,10); header.writeUInt16LE(time,12); header.writeUInt16LE(date,14);
  header.writeUInt32LE(crc,16); header.writeUInt32LE(compressed.length,20); header.writeUInt32LE(entry.data.length,24); header.writeUInt16LE(filename.length,28);
  header.writeUInt32LE(((entry.mode<<16) | (entry.name.endsWith('/')?0x10:0)) >>> 0,38); header.writeUInt32LE(offset,42);
  central.push(header,filename); offset+=local.length+filename.length+compressed.length;
}
const centralData=Buffer.concat(central), end=Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10);
end.writeUInt32LE(centralData.length,12); end.writeUInt32LE(offset,16);
const filename=resolve(dist,'GoodGPT-macOS.zip');
await writeFile(filename,Buffer.concat([...chunks,centralData,end]));
console.log(`macOS app archive ready: ${filename} (${(await stat(filename)).size} bytes).`);
