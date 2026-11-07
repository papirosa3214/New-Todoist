import fs from 'node:fs';import crypto from 'node:crypto';
const sign=id=>{const b=v=>Buffer.from(JSON.stringify(v)).toString('base64url');const h=b({alg:'HS256',typ:'JWT'}),p=b({id,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300});return h+'.'+p+'.'+crypto.createHmac('sha256',process.env.JWT_SECRET).update(h+'.'+p).digest('base64url');};
const roleToken=sign('role_builder'),ownerToken=sign('u1'),machine='c24ec665-d3e3-4265-8a94-412dc39c4ed9',dir='.tool-stack-raw-'+Date.now(),results=[];
async function http(path,token,body){const r=await fetch('http://127.0.0.1:3001'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});return {http:r.status,data:await r.json()};}
const role=(command)=>http('/api/role-host/execute',roleToken,{tool:'bash',arguments:{command,timeout:10}});
const raw=(op,args)=>http('/api/machines/'+machine+'/ops',ownerToken,{op,args});
const seed=await role('mkdir -p '+dir+'/child && printf "raw_audit_marker\\n" > '+dir+'/alpha.txt && printf "second\\n" > '+dir+'/beta.log && pwd');
const root=seed.data.content[0].text.trim();const path=root+'/'+dir;
async function probe(name,op,args,check){const r=await raw(op,args);const pass=r.http===200&&r.data.ok===true&&check(r.data.data);results.push({name,op,status:pass?'PASS':'FAIL',...r});console.log(name,pass?'PASS':'FAIL');}
try{
 await probe('raw/write','write',{path:path+'/new.txt',content:'raw_audit_marker'},d=>d?.created===true);
 await probe('raw/read','read',{path:path+'/new.txt'},d=>d?.content==='raw_audit_marker');
 await probe('raw/ls','ls',{path},d=>d.entries.some(e=>e.name==='alpha.txt')&&d.entries.some(e=>e.name==='beta.log'));
 await probe('raw/grep','grep',{path,pattern:'raw_audit_marker'},d=>d.matches.some(e=>e.path.endsWith('alpha.txt')));
 await probe('raw/find glob semantics','find',{path,pattern:'*.txt'},d=>d.entries.length>0&&d.entries.every(e=>e.path.endsWith('.txt')));
}finally{
 const cleanup=await role('rm -rf -- '+dir+' && test ! -e '+dir+' && printf cleanup_ok');
 results.push({name:'cleanup',status:cleanup.data.content?.[0]?.text?.includes('cleanup_ok')?'PASS':'FAIL'});
 fs.writeFileSync('../docs/2026-10-20-tool-stack-audit/raw-host-results.json',JSON.stringify({at:new Date().toISOString(),results},null,2));
}
