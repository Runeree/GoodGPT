import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
const data=await readFile(new URL('../../dist/GoodGPT-Linux.deb',import.meta.url));
assert.equal(data.toString('ascii',0,8),'!<arch>\n');
const members=new Map();
for(let offset=8;offset<data.length;) {
  assert.equal(data.toString('ascii',offset+58,offset+60),'`\n');
  const name=data.toString('ascii',offset,offset+16).trim().replace(/\/$/,'');
  const size=Number(data.toString('ascii',offset+48,offset+58).trim());
  assert.ok(Number.isSafeInteger(size) && size>0);
  members.set(name,data.subarray(offset+60,offset+60+size));
  offset+=60+size+size%2;
}
assert.equal(members.get('debian-binary').toString(),'2.0\n');
function untar(data) {
  const entries=new Map();
  for(let offset=0;offset<data.length && data[offset];) {
    const field=(at,size)=>data.toString('utf8',offset+at,offset+at+size).replace(/\0.*$/s,'');
    const name=field(0,100), mode=parseInt(field(100,8),8), size=parseInt(field(124,12),8);
    assert.ok(!name.startsWith('/') && !name.includes('..'));
    const header=Buffer.from(data.subarray(offset,offset+512)), expected=parseInt(field(148,8),8);
    header.fill(32,148,156);
    assert.equal(header.reduce((sum,byte)=>sum+byte,0),expected,'Tar checksum: '+name);
    entries.set(name,{mode,data:data.subarray(offset+512,offset+512+size)});
    offset+=512+Math.ceil(size/512)*512;
  }
  return entries;
}
const control=untar(gunzipSync(members.get('control.tar.gz'))).get('control').data.toString();
const version=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8')).version;
assert.ok(control.includes('Version: '+version+'\n'));
assert.match(control,/Architecture: all\n/);
for(const dependency of ['python3-gi-cairo','python3-pyatspi','gir1.2-gtk-3.0','xdotool']) assert.ok(control.includes(dependency));
const files=untar(gunzipSync(members.get('data.tar.gz')));
assert.equal(files.get('usr/bin/goodgpt').mode,0o755);
assert.ok(!files.get('usr/bin/goodgpt').data.includes('\r'));
for(const path of ['usr/share/goodgpt/goodgpt.py','usr/share/goodgpt/bridge.py','usr/share/goodgpt/bag.png','usr/share/goodgpt/treats.png','usr/share/applications/goodgpt.desktop']) assert.ok(files.has(path),path);
assert.ok(![...files.keys()].some(path=>/\.(pem|key|crx)$|\.env|node_modules/.test(path)));
console.log(`Linux Debian package OK: ${(data.length/1024/1024).toFixed(1)} MiB; launcher executable; GTK/AT-SPI dependencies declared.`);
