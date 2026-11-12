import {describe,it,expect,vi} from "vitest";
import {storeBrokerOAuthCredential} from "../src/runtime/brokerOAuth.js";

describe("broker OAuth handoff",()=>{
 it("stores a completed Codex OAuth credential in the broker without exposing it",async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({id:"openai-codex",name:"OpenAI Codex"}),{status:200,headers:{"content-type":"application/json"}}));
  const accountId="acct_fixture";
  const access=["x",Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:accountId}})).toString("base64url"),"y"].join(".");
  await storeBrokerOAuthCredential("openai-codex",{type:"oauth",access,refresh:"refresh-fixture",expires:1_900_000_000_000},{fetch,readToken:()=>"owner-token",brokerUrl:"http://127.0.0.1:28443"});
  const [url,init]=fetch.mock.calls[0];
  expect(url).toBe("http://127.0.0.1:28443/owner-api/secrets/openai-codex");
  expect(init.headers.authorization).toBe("Bearer owner-token");
  const body=JSON.parse(init.body);
  expect(body.oauth.token_url).toBe("https://auth.openai.com/oauth/token");
  expect(body.oauth.access_token).toBe(access);
  expect(body.oauth.refresh_token).toBe("refresh-fixture");
  expect(body.oauth.expires_at).toBe(1_900_000_000);
  expect(body.account_id).toBe(accountId);
 });
 it("rejects a non-OAuth credential before calling the broker",async()=>{
  const fetch=vi.fn();
  await expect(storeBrokerOAuthCredential("xai",{type:"api_key",key:"x"} as any,{fetch,readToken:()=>"owner"})).rejects.toThrow("OAuth credential");
  expect(fetch).not.toHaveBeenCalled();
 });
});
