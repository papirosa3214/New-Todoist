import {it,expect,vi,afterEach} from "vitest";
vi.mock("../src/runtime/secretBrokerRuntime.js",()=>({secretBrokerService:vi.fn(()=>({provider:"anthropic"})),fetchWithSecretBroker:vi.fn()}));
import {fetchWithSecretBroker} from "../src/runtime/secretBrokerRuntime.js";
import {callUnifiedAi} from "../src/lib/aiClient.js";
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks()});
it("uses a prepared broker route without requiring an Anthropic environment key",async()=>{
 vi.stubEnv("ANTHROPIC_API_KEY","");const direct=vi.fn(()=>{throw new Error("direct request forbidden")});vi.stubGlobal("fetch",direct);
 vi.mocked(fetchWithSecretBroker).mockResolvedValue(new Response(JSON.stringify({content:[{type:"text",text:"ready"}]})));
 try{
  expect(await callUnifiedAi({provider:"claude",systemPrompt:"s",userPrompt:"u",aiModel:"owner-selected-model"})).toBe("ready");
  expect(fetchWithSecretBroker).toHaveBeenCalledWith("anthropic","https://api.anthropic.com/v1/messages",expect.objectContaining({method:"POST"}));
  const args=vi.mocked(fetchWithSecretBroker).mock.calls[0];expect(JSON.parse(String(args[2]?.body)).model).toBe("owner-selected-model");
  expect(direct).not.toHaveBeenCalled();
 }finally{vi.unstubAllGlobals()}
});
it("does not substitute a local model when the prepared broker route fails",async()=>{
 vi.stubEnv("ANTHROPIC_API_KEY","");vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new Error("unbound request forbidden")));vi.mocked(fetchWithSecretBroker).mockRejectedValue(new Error("broker unavailable"));
 await expect(callUnifiedAi({provider:"claude",systemPrompt:"s",userPrompt:"u"})).rejects.toThrow("broker");
});
