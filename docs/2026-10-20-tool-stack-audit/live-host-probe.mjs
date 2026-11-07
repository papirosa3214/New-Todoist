import crypto from 'node:crypto';
import fs from 'node:fs';
const dir='.tool-stack-audit-'+Date.now();
const out=[];
const sign=(id)=>{const b=v=>Buffer.from(JSON.stringify(v)).toString('base64url');const h=b({alg:'HS256',typ:'JWT'});const p=b({id,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300});return h+'.'+p+'.'+crypto.createHmac('sha256',process.env.JWT_SECRET).update(h+'.'+p).digest('base64url');};
const token=sign('role_builder');
async function call(name,tool,args,check,expected=200){
 try{
  const started=Date.now();
  const response=await fetch('http://127.0.0.1:3001/api/role-host/execute',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({tool,arguments:args}),signal:AbortSignal.timeout(25000)});
  const body=await response.text();let parsed;try{parsed=JSON.parse(body);}catch{parsed=body;}
  const text=parsed?.content?.map(x=>x.text??'').join('\n')??body;
  const pass=response.status===expected && check(text,parsed);
  out.push({name,tool,status:pass?'PASS':'FAIL',http:response.status,ms:Date.now()-started,text:text.slice(0,1700)});
  console.log(name,pass?'PASS':'FAIL',response.status);
  return {text,parsed};
 }catch(e){out.push({name,tool,status:'FAIL',error:e.message});console.log(name,'FAIL',e.message);}
}
try{
 await call('bash/create fixtures','bash',{command:'mkdir -p '+dir+'/child && printf "audit_alpha\\naudit_beta\\n" > '+dir+'/alpha.txt && printf "second\\n" > '+dir+'/beta.log && pwd',timeout:10},t=>t.includes('/Users/max/'));
 await call('read/text','read',{path:dir+'/alpha.txt'},t=>t.includes('audit_alpha'));
 await call('edit/existing','edit',{path:dir+'/alpha.txt',edits:[{oldText:'audit_alpha',newText:'audit_gamma'}]},t=>t.includes('Successfully'));
 await call('read/verify edit','read',{path:dir+'/alpha.txt'},t=>t.includes('audit_gamma')&&!t.includes('audit_alpha'));
 await call('write/new file','write',{path:dir+'/new.txt',content:'new audit file'},t=>t.includes('Successfully'));
 await call('ls/files and directory','ls',{path:dir},t=>t.includes('alpha.txt')&&t.includes('beta.log')&&t.includes('child/'));
 await call('grep/directory','grep',{pattern:'audit_gamma',path:dir},t=>t.includes('audit_gamma'));
 await call('grep/single file','grep',{pattern:'audit_gamma',path:dir+'/alpha.txt'},t=>t.includes('audit_gamma'));
 await call('find/glob','find',{pattern:'*.txt',path:dir},t=>t.includes('alpha.txt')&&!t.includes('beta.log')&&!t.includes('[object Object]'));
 await call('path/outside write rejected','write',{path:'/tmp/taskflow-audit-outside.txt',content:'must not write'},t=>t.includes('Путь выходит'),409);
 await call('read/missing file rejected','read',{path:dir+'/missing.txt'},t=>t.includes('нет доступа')||t.includes('ENOENT'),409);
}finally{
 await call('cleanup/own fixtures','bash',{command:'rm -rf -- '+dir+' && test ! -e '+dir+' && printf cleanup_ok',timeout:10},t=>t.includes('cleanup_ok'));
 fs.writeFileSync('../docs/2026-10-20-tool-stack-audit/live-host-results.json',JSON.stringify({at:new Date().toISOString(),dir,results:out},null,2));
}
