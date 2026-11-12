import {it,expect} from "vitest";
import {wealthfolioToken,wealthfolioUrl} from "../src/runtime/wealthfolioMcp.js";
import fs from "node:fs";import os from "node:os";import path from "node:path";
it("prepares broker-only Wealthfolio credentials without touching its vault",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"wealthfolio-broker-"));const file=path.join(dir,"token");
 const previous=process.env.TASKFLOW_SECRET_BROKER_BINDINGS;
 try{
  fs.writeFileSync(file,"connection-fixture",{mode:0o600});
  process.env.TASKFLOW_SECRET_BROKER_BINDINGS=JSON.stringify([{provider:"wealthfolio",alias:"wealthfolio_mcp_token",brokerUrl:"http://127.0.0.1:28443",tokenPath:file,authKind:"api_key"}]);
  expect(wealthfolioUrl()).toBe("http://127.0.0.1:28443/proxy/wealthfolio_mcp_token/");
  expect(await wealthfolioToken()).toBe("connection-fixture");
 }finally{if(previous===undefined)delete process.env.TASKFLOW_SECRET_BROKER_BINDINGS;else process.env.TASKFLOW_SECRET_BROKER_BINDINGS=previous;fs.rmSync(dir,{recursive:true,force:true})}
});
