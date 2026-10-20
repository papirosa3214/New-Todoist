import crypto from 'node:crypto';
import fs from 'node:fs';
const b=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
const h=b({alg:'HS256',typ:'JWT'}),p=b({id:'u1',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300});
const token=h+'.'+p+'.'+crypto.createHmac('sha256',process.env.JWT_SECRET).update(h+'.'+p).digest('base64url');
const results=[];
async function get(path){
 const r=await fetch('http://127.0.0.1:3001'+path,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});
 const data=await r.json();
 const row={path,http:r.status};
 if(path.endsWith('/providers'))row.data=data.providers;
 else if(path.endsWith('/models'))row.data={count:data.models?.length,minimax:data.models?.filter(m=>m.provider==='minimax').map(m=>({id:m.id,available:m.available}))};
 else if(path.endsWith('/profiles'))row.data=data.profiles?.map(v=>({id:v.id,model:v.model,runtime_id:v.runtime_id,tools:v.tools}));
 else if(path.endsWith('/routing'))row.data=data;
 else if(path==='/api/machines')row.data=data.map(v=>({id:v.id,name:v.name,online:v.online,host_version:v.host_version}));
 else row.data=data;
 results.push(row);console.log(path,r.status);
 return data;
}
await get('/api/health');
await get('/api/runtime/status');
await get('/api/runtime/models');
await get('/api/runtime/providers');
await get('/api/runtime/profiles');
await get('/api/runtime/routing');
for(const role of ['builder','secretary']){
 const r=await fetch('http://127.0.0.1:3001/api/roles/'+role+'/composio',{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(40000)});
 const d=await r.json();
 results.push({path:'composio/'+role,http:r.status,enabled:d.enabled,configured:d.configured,available:d.available,count:d.catalog?.length,error:d.error});
 console.log('Composio '+role,r.status,d.available);
}
const machines=await get('/api/machines');
for(const machine of machines.filter(m=>m.online)){
 const r=await fetch('http://127.0.0.1:3001/api/machines/'+machine.id+'/ops',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({op:'things3',args:{tool:'things_today',arguments:{}}}),signal:AbortSignal.timeout(30000)});
 const d=await r.json();
 const content=d?.data?.result??d?.data?.content??d?.stdout;
 results.push({path:'machine/things_today',http:r.status,ok:d.ok,code:d.code,error:d.error,contentType:typeof content,contentLength:typeof content==='string'?content.length:null});
 console.log('Things today',r.status,d.ok);
}
fs.writeFileSync('../docs/2026-10-20-tool-stack-audit/live-state.json',JSON.stringify({at:new Date().toISOString(),results},null,2));
