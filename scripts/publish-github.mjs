// Explicit publishing helper for this project. Credentials stay in process memory.
import { spawnSync, spawn } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile, unlink, access } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const owner = 'Runeree', name = 'GoodGPT', repoPath = `/repos/${owner}/${name}`;
const mode = process.argv[2] || 'inspect';
if (!['inspect', 'create', 'upload', 'release', 'verify'].includes(mode)) throw new Error('Use inspect, create, upload, release or verify.');

const credentials = spawnSync('git', ['credential', 'fill'], {
  input: `protocol=https\nhost=github.com\nusername=${owner}\n\n`, encoding: 'utf8',
  env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' }, windowsHide: true,
  timeout: 30000,
});
if (credentials.status !== 0) throw new Error('GitHub credentials unavailable through Git Credential Manager.');
const fields = Object.fromEntries(credentials.stdout.trim().split(/\r?\n/).map(line => {
  const at=line.indexOf('='); return [line.slice(0,at), line.slice(at+1)];
}));
const token = fields.password;
if (!token) throw new Error('Git Credential Manager returned no GitHub credential.');
// Never print credential output, tokens or request headers.
credentials.stdout = ''; fields.password = '';
const connectedHosts=new Map();
let curlCommand=process.platform==='win32'?'curl.exe':'curl';
if(process.platform==='win32') {
  const gitCurl=resolve(process.env.ProgramFiles || 'C:\\Program Files','Git/mingw64/bin/curl.exe');
  if(await access(gitCurl).then(()=>true,()=>false)) curlCommand=gitCurl;
}
// Optional addresses from a successful connection can carry DNS cache across runs.
for(const [index,host] of ['api.github.com','uploads.github.com'].entries()) {
  const address=process.argv[index+3];
  if(!address) continue;
  if(!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) throw new Error('Expected an IPv4 address.');
  connectedHosts.set(host,address);
}

async function api(path, {method='GET', body, binary=false, allow404=false, timeout=60000}={}) {
  const url = new URL(path.startsWith('https://') ? path : 'https://api.github.com'+path);
  if (!['api.github.com', 'uploads.github.com'].includes(url.hostname)) throw new Error('Refusing to send GitHub credentials to another host.');
  const args=['--silent','--show-error','--ipv4','--http1.1','--compressed','--connect-timeout','10','--max-time',String(timeout/1000),'--proto','=https',
    '--config','-','--request',method,'--url',url.href,'--write-out','\n%{http_code} %{remote_ip}',
    '--header','Accept: application/vnd.github+json','--header','User-Agent: GoodGPT-Publisher','--header','X-GitHub-Api-Version: 2026-03-10',
    '--header','Expect:'];
  // Reuse the address of a successful TLS connection during this publication.
  // TLS certificate verification remains enabled for every request.
  if(connectedHosts.has(url.hostname)) args.push('--resolve',`${url.hostname}:443:${connectedHosts.get(url.hostname)}`);
  let requestFile;
  if (body!==undefined) {
    const requests=resolve(root,'output/publish/requests'); await mkdir(requests,{recursive:true});
    requestFile=resolve(requests,randomUUID());
    await writeFile(requestFile,binary?body:JSON.stringify(body));
    args.push('--header','Content-Type: '+(binary?'application/octet-stream':'application/json'),'--data-binary','@'+requestFile);
  }
  let output;
  try {
    const perform=()=>new Promise((resolve,reject)=>{
      const child=spawn(curlCommand,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
      const chunks=[],errors=[];
      child.stdout.on('data',chunk=>chunks.push(chunk)); child.stderr.on('data',chunk=>errors.push(chunk));
      child.on('error',reject);
      child.on('close',code=>{
        if(code===0) return resolve(Buffer.concat(chunks).toString('utf8'));
        const error=new Error('GitHub connection failed: '+Buffer.concat(errors).toString('utf8').slice(0,500));
        error.curlCode=code; reject(error);
      });
      // curl reads the auth header from stdin, never from a file or command line.
      child.stdin.end('header = '+JSON.stringify('Authorization: Bearer '+token)+'\n');
    });
    for(let attempt=0;;attempt++) {
      try { output=await perform(); break; }
      catch(error) {
        // DNS and connection failures happen before any HTTP request is sent.
        // Do not automatically repeat a write after an ambiguous timeout.
        const beforeRequest=[6,7].includes(error.curlCode) ||
          (error.curlCode===28 && /Connection timed out|Resolving timed out|SSL connection timeout/i.test(error.message));
        const repeatableRead=method==='GET' && [18,28,52,56].includes(error.curlCode);
        if((!beforeRequest && !repeatableRead) || attempt>=3) throw error;
        console.log(`GitHub connection retry ${attempt+1}/3`);
        await new Promise(done=>setTimeout(done,1000*(attempt+1)));
      }
    }
  } finally { if(requestFile) await unlink(requestFile).catch(()=>{}); }
  const at=output.lastIndexOf('\n'), [statusText,remoteIp]=output.slice(at+1).trim().split(/\s+/);
  const status=Number(statusText), text=output.slice(0,at);
  if(/^(?:\d{1,3}\.){3}\d{1,3}$/.test(remoteIp || '')) connectedHosts.set(url.hostname,remoteIp);
  if (allow404 && status===404) return null;
  let value; try {value=text?JSON.parse(text):null;} catch {value=null;}
  if (status<200 || status>=300) throw new Error(`GitHub ${method} ${url.pathname}: ${status} ${value?.message || 'request failed'}`);
  return value;
}

const user=await api('/user');
if (user.login.toLowerCase() !== owner.toLowerCase()) throw new Error(`Selected GitHub account is ${user.login}; expected ${owner}. No write performed.`);
console.log(`GitHub account: ${user.login}`);
let repo=await api(repoPath,{allow404:true});
if (mode==='inspect') {
  console.log(JSON.stringify({repository:repo?.html_url||null,visibility:repo?.visibility||null,defaultBranch:repo?.default_branch||null}));
  process.exit(0);
}
if (mode==='create') {
  if (!repo) repo=await api('/user/repos',{method:'POST',body:{name,description:'GoodGPT: угощения и похвала для Codex (ChatGPT) и Claude Code. Windows, macOS и Chrome.',private:false,auto_init:true,has_issues:true,has_projects:false,has_wiki:false}});
  else if (repo.private) throw new Error('A private repository with this name already exists. Refusing to change visibility automatically.');
  if (repo.default_branch && repo.default_branch!=='main') {
    await api(`${repoPath}/branches/${encodeURIComponent(repo.default_branch)}/rename`,{method:'POST',body:{new_name:'main'}});
    repo=await api(repoPath);
  }
  await api(repoPath+'/topics',{method:'PUT',body:{names:['chatgpt','codex','browser-extension','windows','macos','desktop-app','positive-feedback']}});
  console.log(`Public repository ready: ${repo.html_url}`);
  process.exit(0);
}
if (!repo || repo.private) throw new Error('Expected the public Runeree/GoodGPT repository.');

if (mode==='upload') {
  const paths=[];
  async function walk(folder) {
    for (const item of await readdir(resolve(root,folder),{withFileTypes:true})) {
      if (item.isSymbolicLink()) throw new Error('Symlinks are not included in a public upload.');
      const path=folder+'/'+item.name;
      if (item.isDirectory()) await walk(path); else paths.push(path);
    }
  }
  for (const folder of ['assets','desktop','src','scripts','tests']) await walk(folder);
  paths.push('README.md','INSTALL.txt','LICENSE','package.json','.gitignore','.gitattributes','RELEASE.md');
  paths.sort();
  if (paths.some(path=>/(?:^|\/)(?:\.git|node_modules|dist|\.env)(?:\/|$)|\.(?:pem|key|pfx|p12|crx)$/i.test(path))) throw new Error('Unexpected private or generated file in publication list.');
  const branch=repo.default_branch;
  const head=await api(`${repoPath}/git/ref/heads/${branch}`);
  const oldCommit=await api(`${repoPath}/git/commits/${head.object.sha}`);
  const oldTree=await api(`${repoPath}/git/trees/${oldCommit.tree.sha}?recursive=1`);
  const existing=new Map(oldTree.tree.map(entry=>[entry.path,entry]));
  const entries=[];
  let cursor=0, complete=0;
  await Promise.all(Array.from({length:3},async()=>{
    for (;;) {
      const index=cursor++; if(index>=paths.length) return;
      const path=paths[index], data=await readFile(resolve(root,path));
      const blobSha=createHash('sha1').update(Buffer.from(`blob ${data.length}\0`)).update(data).digest('hex');
      let sha=blobSha;
      if (existing.get(path)?.sha!==blobSha) {
        sha=(await api(`${repoPath}/git/blobs`,{method:'POST',body:{content:data.toString('base64'),encoding:'base64'}})).sha;
      }
      entries.push({path,mode:path==='desktop/macos/GoodGPT'?'100755':'100644',type:'blob',sha});
      complete++; if (complete%12===0 || complete===paths.length) console.log(`Prepared files: ${complete}/${paths.length}`);
    }
  }));
  entries.sort((a,b)=>a.path.localeCompare(b.path));
  const tree=await api(`${repoPath}/git/trees`,{method:'POST',body:{base_tree:oldCommit.tree.sha,tree:entries}});
  if (tree.sha===oldCommit.tree.sha) {console.log('Repository source already matches this workspace.');process.exit(0);}
  const commit=await api(`${repoPath}/git/commits`,{method:'POST',body:{message:'Release GoodGPT for Windows, macOS and Chrome',tree:tree.sha,parents:[head.object.sha],author:{name:'Stepan Konovalov',email:'120125513+Runeree@users.noreply.github.com',date:new Date().toISOString()}}});
  // force:false preserves any concurrent work in the public repository.
  await api(`${repoPath}/git/refs/heads/${branch}`,{method:'PATCH',body:{sha:commit.sha,force:false}});
  console.log(`Source published: ${commit.html_url}`);
  process.exit(0);
}

if (mode==='release') {
  const version=JSON.parse(await readFile(resolve(root,'package.json'),'utf8')).version;
  const tag='v'+version, body=await readFile(resolve(root,'RELEASE.md'),'utf8');
  const runs=await api(`${repoPath}/actions/runs?branch=${encodeURIComponent('release/'+version)}&per_page=10`);
  for(const run of runs.workflow_runs || []) {
    if(run.path!=='.github/workflows/release.yml' || run.status==='completed') continue;
    try {
      await api(`${repoPath}/actions/runs/${run.id}/cancel`,{method:'POST'});
      console.log(`Stopped duplicate build: ${run.id}`);
    } catch(error) {
      if(!String(error.message).includes(': 409 ')) throw error;
      console.log(`Build has no allocated runner: ${run.id}. Publishing existing packages.`);
    }
  }
  await api(repoPath,{method:'PATCH',body:{description:'GoodGPT: угощения и похвала для Codex (ChatGPT) и Claude Code. Windows, macOS и Chrome.'}});
  let release=await api(`${repoPath}/releases/tags/${tag}`,{allow404:true});
  if (!release) release=await api(`${repoPath}/releases`,{method:'POST',body:{tag_name:tag,target_commitish:repo.default_branch,name:'GoodGPT '+version,body,draft:true,prerelease:false}});
  const names=['GoodGPT-Windows.exe','GoodGPT-macOS.zip','GoodGPT-Chrome.zip','GoodGPT-All.zip','SHA256SUMS.txt'];
  async function uploadAsset(assetName) {
    const data=await readFile(resolve(root,'dist',assetName));
    const digest='sha256:'+createHash('sha256').update(data).digest('hex');
    const present=release.assets.find(asset=>asset.name===assetName);
    if (present) {
      if (present.digest===digest) {console.log(`Asset already uploaded: ${assetName}`);return;}
      throw new Error(`Release already contains a different ${assetName}; refusing to overwrite.`);
    }
    const base=release.upload_url.split('{')[0];
    const asset=await api(`${base}?name=${encodeURIComponent(assetName)}`,{method:'POST',body:data,binary:true,timeout:300000});
    if (asset.size!==data.length || (asset.digest && asset.digest!==digest)) throw new Error('Uploaded asset integrity mismatch: '+assetName);
    console.log(`Uploaded: ${asset.name} (${asset.size} bytes)`);
  }
  let nextAsset = 0;
  await Promise.all(Array.from({length:3}, async () => {
    for (;;) { const index = nextAsset++; if (index >= names.length) return; await uploadAsset(names[index]); }
  }));
  if(release.draft) release=await api(`${repoPath}/releases/${release.id}`,{method:'PATCH',body:{draft:false,body}});
  console.log(`Release published: ${release.html_url}`);
  process.exit(0);
}

if (mode==='verify') {
  const release=await api(`${repoPath}/releases/latest`);
  const tree=await api(`${repoPath}/git/trees/${repo.default_branch}?recursive=1`);
  const files=tree.tree.filter(entry=>entry.type==='blob').map(entry=>entry.path);
  if (files.some(path=>/\.pem$|\.crx$|(?:^|\/)\.env$/.test(path))) throw new Error('Unexpected private/generated file in public tree.');
  console.log(JSON.stringify({repository:repo.html_url,public:!repo.private,files:files.length,release:release.html_url,assets:release.assets.map(asset=>({name:asset.name,size:asset.size,url:asset.browser_download_url,digest:asset.digest})),sourceArchive:`${repo.html_url}/archive/refs/tags/${release.tag_name}.zip`},null,2));
}
