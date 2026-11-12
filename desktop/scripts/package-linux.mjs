// Debian package writer, using Node standard libraries. Also runs on Windows.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root=fileURLToPath(new URL('../../',import.meta.url));
const {version}=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
const contents=[];
for(const [source,name,mode=0o644] of [
  ['desktop/linux/goodgpt','usr/bin/goodgpt',0o755],
  ['desktop/linux/goodgpt.py','usr/share/goodgpt/goodgpt.py'],
  ['desktop/linux/bridge.py','usr/share/goodgpt/bridge.py'],
  ['assets/bag.png','usr/share/goodgpt/bag.png'],
  ['assets/treats.png','usr/share/goodgpt/treats.png'],
  ['assets/icon-128.png','usr/share/icons/hicolor/128x128/apps/goodgpt.png'],
  ['desktop/linux/goodgpt.desktop','usr/share/applications/goodgpt.desktop'],
  ['desktop/linux/README.md','usr/share/doc/goodgpt/README.md'],
  ['LICENSE','usr/share/doc/goodgpt/copyright'],
]) {
  let data=await readFile(resolve(root,source));
  if(!source.endsWith('.png')) data=Buffer.from(data.toString('utf8').replace(/^\uFEFF/,'').replace(/\r\n/g,'\n'));
  contents.push({name,data,mode});
}

// POSIX ustar, root ownership and explicit executable permissions.
export function tar(entries) {
  const folders=new Set();
  for(const entry of entries) {
    const parts=entry.name.split('/'); parts.pop();
    while(parts.length) {folders.add(parts.join('/')+'/');parts.pop();}
  }
  const all=[...Array.from(folders).sort().map(name=>({name,data:Buffer.alloc(0),mode:0o755,directory:true})),...entries];
  const chunks=[];
  for(const entry of all) {
    if(Buffer.byteLength(entry.name)>100 || entry.name.startsWith('/') || entry.name.includes('..')) throw new Error('Unsafe tar path.');
    const header=Buffer.alloc(512);
    const field=(value,offset,size)=>header.write(value,offset,size,'ascii');
    const octal=(value,offset,size)=>field(value.toString(8).padStart(size-1,'0')+'\0',offset,size);
    field(entry.name,0,100); octal(entry.mode,100,8); octal(0,108,8); octal(0,116,8);
    octal(entry.data.length,124,12); octal(0,136,12);
    header.fill(32,148,156); field(entry.directory?'5':'0',156,1);
    field('ustar\0',257,6);field('00',263,2);field('root',265,32);field('root',297,32);
    const checksum=header.reduce((sum,byte)=>sum+byte,0);
    field(checksum.toString(8).padStart(6,'0')+'\0 ',148,8);
    chunks.push(header,entry.data,Buffer.alloc((512-entry.data.length%512)%512));
  }
  return Buffer.concat([...chunks,Buffer.alloc(1024)]);
}

const control=Buffer.from(`Package: goodgpt
Version: ${version}
Section: utils
Priority: optional
Architecture: all
Maintainer: Stepan Konovalov <120125513+Runeree@users.noreply.github.com>
Installed-Size: ${Math.ceil(contents.reduce((size,file)=>size+file.data.length,0)/1024)}
Depends: python3 (>= 3.10), python3-gi, python3-cairo, python3-gi-cairo, python3-pyatspi, gir1.2-gtk-3.0, xdotool
Homepage: https://github.com/Runeree/GoodGPT
Description: A bag of treats and praise for AI chats
 GTK3 desktop overlay for an X11 session with a compositor.
 Sends praise through the active supported chat using AT-SPI and normal input.
 No account, API key or GoodGPT server is needed.
`);
const md5=Buffer.from(contents.map(file=>createHash('md5').update(file.data).digest('hex')+'  '+file.name).join('\n')+'\n');
const members=[
  ['debian-binary',Buffer.from('2.0\n')],
  ['control.tar.gz',gzipSync(tar([{name:'control',data:control,mode:0o644},{name:'md5sums',data:md5,mode:0o644}]))],
  ['data.tar.gz',gzipSync(tar(contents))],
];
const chunks=[Buffer.from('!<arch>\n')];
for(const [name,data] of members) {
  chunks.push(Buffer.from((name+'/').padEnd(16)+'0'.padEnd(12)+'0'.padEnd(6)+'0'.padEnd(6)+'100644'.padEnd(8)+String(data.length).padEnd(10)+'`\n'));
  chunks.push(data);if(data.length%2) chunks.push(Buffer.from('\n'));
}
await mkdir(resolve(root,'dist'),{recursive:true});
const path=resolve(root,'dist/GoodGPT-Linux.deb');
await writeFile(path,Buffer.concat(chunks));
console.log(`Linux package ready: ${path} (${version}, architecture all, Python/GTK3).`);
