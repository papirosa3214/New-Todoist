import fs from "node:fs";
import path from "node:path";
import {createInterface} from "node:readline";
import {recordModelUsage,readModelUsage} from "../src/lib/modelUsage.js";
async function* files(dir:string):AsyncGenerator<string> {
 for(const item of await fs.promises.readdir(dir,{withFileTypes:true})){
  const p=path.join(dir,item.name);
  if(item.isDirectory())yield* files(p);else if(item.isFile() && p.endsWith(".jsonl"))yield p;
 }
}
const roots=process.argv.slice(2);
if(!roots.length)throw new Error("Pass trusted session directories explicitly");
let scanned=0,added=0,malformed=0;
for(const root of roots)for await(const file of files(root)){
 for await(const line of createInterface({input:fs.createReadStream(file),crlfDelay:Infinity})){
  let row:any;try{row=JSON.parse(line);}catch{malformed++;continue;}
  if(row.type==="message" && row.message?.role==="assistant"){scanned++;if(recordModelUsage(row.message,"session"))added++;}
 }
}
console.log(JSON.stringify({scanned,added,malformed,summary:readModelUsage("month")}));
