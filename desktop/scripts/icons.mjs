import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const folder = resolve(root, 'desktop/resources');
await mkdir(folder, { recursive: true });
const sizes = [16, 32, 48, 128];
const images = await Promise.all(sizes.map(size => readFile(resolve(root, `assets/icon-${size}.png`))));
const icoHeader = Buffer.alloc(6 + images.length * 16);
icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(images.length, 4);
let offset = icoHeader.length;
images.forEach((image, index) => {
  const at = 6 + index * 16;
  icoHeader[at] = sizes[index]; icoHeader[at + 1] = sizes[index];
  icoHeader.writeUInt16LE(1, at + 4); icoHeader.writeUInt16LE(32, at + 6);
  icoHeader.writeUInt32LE(image.length, at + 8); icoHeader.writeUInt32LE(offset, at + 12);
  offset += image.length;
});
await writeFile(resolve(folder, 'GoodGPT.ico'), Buffer.concat([icoHeader, ...images]));
const icnsParts = [];
for (const [type, index] of [['icp4', 0], ['icp5', 1], ['ic07', 3]]) {
  const header = Buffer.alloc(8); header.write(type); header.writeUInt32BE(images[index].length + 8, 4);
  icnsParts.push(header, images[index]);
}
const icnsHeader = Buffer.alloc(8); icnsHeader.write('icns');
icnsHeader.writeUInt32BE(8 + icnsParts.reduce((total, part) => total + part.length, 0), 4);
await writeFile(resolve(folder, 'GoodGPT.icns'), Buffer.concat([icnsHeader, ...icnsParts]));
console.log('Native desktop icons ready.');
