import fs from "node:fs"; import path from "node:path";
const root = process.argv[2];
function strip(src){let out="",i=0;const n=src.length;while(i<n){const c=src[i],nx=src[i+1];
if(c==="/"&&nx==="/"){while(i<n&&src[i]!=="\n")i++;continue}
if(c==="/"&&nx==="*"){i+=2;while(i<n&&!(src[i]==="*"&&src[i+1]==="/")){if(src[i]==="\n")out+="\n";i++}i+=2;continue}
if(c==='"'||c==="'"||c==="`"){const q=c;i++;out+=q;while(i<n&&src[i]!==q){if(src[i]==="\\"){i++;if(i<n){if(src[i]==="\n")out+="\n";i++}continue}if(src[i]==="\n")out+="\n";i++}out+=q;i++;continue}
out+=c;i++}return out}
function names(src){const res=[];const code=strip(src);const re=/import\s+(type\s+)?([^'";]*?)\s+from\s*['"][^'"]*['"]/g;let m;
while((m=re.exec(code))){if(m[1])continue;const cl=m[2].trim();const bi=cl.indexOf("{");const head=(bi===-1?cl:cl.slice(0,bi)).replace(/,\s*$/,"").trim();
if(head.startsWith("*")){const ns=head.match(/\*\s+as\s+([A-Za-z0-9_$]+)/);if(ns)res.push(ns[1])}else if(head){const d=head.match(/^[A-Za-z0-9_$]+/);if(d)res.push(d[0])}
if(bi!==-1){const e=cl.indexOf("}",bi);const inner=cl.slice(bi+1,e===-1?undefined:e);
for(const part of inner.split(",")){const p=part.trim().replace(/^type\s+/,"");if(!p)continue;const a=p.match(/\bas\s+([A-Za-z0-9_$]+)$/);res.push(a?a[1]:p)}}}return res}
let files=[];function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(/\.tsx$/.test(e.name))files.push(p)}}
walk(path.join(root,"src"));
let bad=0;for(const f of files){const c=new Map();for(const n of names(fs.readFileSync(f,"utf8")))c.set(n,(c.get(n)||0)+1);
for(const [n,k] of c) if(k>1){bad++;console.log("ДУБЛЬ",path.relative(root,f),n,k)}}
console.log("файлов src:",files.length,"дублей:",bad);
