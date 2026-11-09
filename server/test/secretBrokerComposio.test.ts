import {describe,it,expect,vi,afterEach} from "vitest";
import {composioCommand} from "../src/runtime/composioPolicy.js";
import * as bridge from "../scripts/composio_mcp.mjs";
afterEach(()=>vi.unstubAllEnvs());
const binding={provider:"composio",alias:"composio-taskflow",brokerUrl:"http://127.0.0.1:28443",tokenPath:"/unused",authKind:"api_key"};
describe("Composio broker preparation",()=>{
 it("does not read broker credentials in legacy mode",async()=>{
  const io={stat:vi.fn(),readFile:vi.fn()};
  const c=await bridge.composioClientConfig({COMPOSIO_API_KEY:"legacy-fixture"},io);
  expect(c.apiKey).toBe("legacy-fixture");expect(c.baseURL).toBeUndefined();expect(io.readFile).not.toHaveBeenCalled();
 });
 it("uses only a broker connection token and the existing service alias",async()=>{
  const io={stat:vi.fn().mockResolvedValue({isFile:()=>true,mode:0o600}),readFile:vi.fn().mockResolvedValue("connection-fixture\n")};
  const c=await bridge.composioClientConfig({TASKFLOW_COMPOSIO_BROKER_URL:"http://127.0.0.1:28443/proxy/composio-taskflow",TASKFLOW_COMPOSIO_BROKER_TOKEN_PATH:"/unused",COMPOSIO_API_KEY:"must-not-use"},io);
  expect(c.apiKey).toBe("connection-fixture");expect(c.baseURL).toBe("http://127.0.0.1:28443/proxy/composio-taskflow");
  expect(JSON.stringify(c)).not.toContain("must-not-use");
 });
 it("rejects an unavailable broker token without falling back to vault",async()=>{
  await expect(bridge.composioClientConfig({TASKFLOW_COMPOSIO_BROKER_URL:"http://127.0.0.1:28443/proxy/composio-taskflow",TASKFLOW_COMPOSIO_BROKER_TOKEN_PATH:"/missing",COMPOSIO_API_KEY:"legacy"},{stat:vi.fn().mockRejectedValue(new Error("missing"))})).rejects.toThrow();
 });
 it("prepares a node launch without the vault launcher or real API credential",()=>{
  vi.stubEnv("TASKFLOW_SECRET_BROKER_BINDINGS",JSON.stringify([binding]));vi.stubEnv("COMPOSIO_API_KEY","real-fixture");
  const c=composioCommand({role:"researcher",ownerId:"owner",enabled:true,toolkits:null},"work","chat");
  expect(c.command).toBe(process.execPath);expect(c.args.join(" ")).not.toContain("vault");
  expect(c.env.COMPOSIO_API_KEY).toBe("");
  expect(c.env.TASKFLOW_COMPOSIO_BROKER_TOKEN_PATH).toBe("/unused");
 });
});
