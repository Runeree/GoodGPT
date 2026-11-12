import {readFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const repository=process.env.GITHUB_REPOSITORY;
const token=process.env.GH_TOKEN;
const commit=process.env.GITHUB_SHA;
if(!token || !/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !/^[0-9a-f]{40}$/.test(commit || '')) {
  throw new Error('Run this publisher in the GitHub Actions release workflow.');
}
const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const tag='v'+version;
const prefix=`/repos/${repository}`;
async function api(path,{method='GET',body,binary=false,allow404=false}={}) {
  const url=new URL(path.startsWith('https://')?path:'https://api.github.com'+path);
  if(!['api.github.com','uploads.github.com'].includes(url.hostname)) throw new Error('Unexpected GitHub host.');
  const response=await fetch(url,{
    method,redirect:'error',signal:AbortSignal.timeout(binary?240000:60000),
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'GoodGPT-Release',
      ...(body===undefined?{}:{'Content-Type':binary?'application/octet-stream':'application/json'})},
    ...(body===undefined?{}:{body:binary?body:JSON.stringify(body)}),
  });
  if(allow404 && response.status===404) return null;
  if(!response.ok) throw new Error(`GitHub ${method} ${url.pathname}: HTTP ${response.status}`);
  return response.status===204?null:response.json();
}

const names=['GoodGPT-Windows.exe','GoodGPT-macOS.zip','GoodGPT-Linux.deb','GoodGPT-Chrome.zip','GoodGPT-All.zip','SHA256SUMS.txt'];
const assets=[];
for(const name of names) {
  const data=await readFile(new URL('../dist/'+name,import.meta.url));
  assets.push({name,data,digest:'sha256:'+createHash('sha256').update(data).digest('hex')});
}
let release=await api(`${prefix}/releases/tags/${tag}`,{allow404:true});
if(release && !release.draft) {
  if(assets.every(asset=>release.assets.some(existing=>existing.name===asset.name && existing.digest===asset.digest))) {
    console.log('Release is already complete: '+release.html_url);
    process.exit(0);
  }
  throw new Error(`${tag} is already public. Bump package.json before publishing another build.`);
}
const body=await readFile(new URL('../RELEASE.md',import.meta.url),'utf8');
if(!release) release=await api(`${prefix}/releases`,{method:'POST',body:{tag_name:tag,target_commitish:commit,name:'GoodGPT '+version,body,draft:true,prerelease:false}});
for(const asset of assets) {
  const existing=release.assets.find(item=>item.name===asset.name);
  if(existing?.digest===asset.digest) continue;
  if(existing) await api(`${prefix}/releases/assets/${existing.id}`,{method:'DELETE'});
  const upload=release.upload_url.split('{')[0]+'?name='+encodeURIComponent(asset.name);
  const result=await api(upload,{method:'POST',body:asset.data,binary:true});
  if(result.size!==asset.data.length || (result.digest && result.digest!==asset.digest)) throw new Error('Asset integrity mismatch: '+asset.name);
  console.log(`Uploaded ${asset.name}: ${asset.data.length} bytes`);
}
release=await api(`${prefix}/releases/${release.id}`,{method:'PATCH',body:{draft:false,body}});
console.log('Published '+release.html_url);
if(process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY,`[GoodGPT ${version}](${release.html_url})\n\n`+assets.map(asset=>`- [${asset.name}](https://github.com/${repository}/releases/download/${tag}/${asset.name})`).join('\n')+'\n');
}
