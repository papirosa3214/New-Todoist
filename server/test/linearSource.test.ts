import {describe,it,expect} from "vitest";
import {fetchLinearSnapshot,listLinearIssues} from "../src/lib/linearSource.js";
const conn=(nodes:any[],next:string|null=null)=>({nodes,pageInfo:{hasNextPage:!!next,endCursor:next}});
const issue=(id:string,parent:string|null,children:string[])=>({id,parent:parent?{id:parent}:null,children:conn(children.map(id=>({id}))),labels:conn([]),comments:conn([]),history:conn([]),relations:conn([]),inverseRelations:conn([]),attachments:conn([]),documents:conn([])});
describe("Linear source completeness",()=>{
 it("selected child includes ancestors without importing ancestor siblings",async()=>{
  const items:any={root:issue("root",null,["child","sibling"]),child:issue("child","root",["grandchild"]),grandchild:issue("grandchild","child",[]),sibling:issue("sibling","root",[])};
  const result=await fetchLinearSnapshot("owner",["child"],async(_,query,vars)=>{expect(query).not.toMatch(/\bmutation\b/);return {organization:{id:"workspace",name:"W"},issue:structuredClone(items[vars!.id as string])};});
  expect(new Set(result.issues.map(i=>i.id))).toEqual(new Set(["root","child","grandchild"]));
 });
 it("paginates nested children and history instead of truncating them",async()=>{
  const root:any=issue("root",null,["child"]);root.children.pageInfo={hasNextPage:true,endCursor:"next"};root.history=conn([{id:"event1"}],"history-next");
  const result=await fetchLinearSnapshot("owner",["root"],async(_,query,vars)=>{
   if(query.includes("TaskFlowLinearCollection"))return {issue:query.includes("children(")?{children:conn([{id:"second"}])}:{history:conn([{id:"event2"}])}};
   return {organization:{id:"workspace",name:"W"},issue:structuredClone(vars!.id==="root"?root:issue(vars!.id as string,"root",[]))};
  });
  expect(result.issues).toHaveLength(3);expect(result.issues[0].history).toHaveLength(2);
 });
 it("fails explicitly on missing collections, missing parents and workspace switch",async()=>{
  await expect(fetchLinearSnapshot("owner",["root"],async()=>({organization:{id:"W"},issue:{id:"root"}}))).rejects.toThrow(/неполную коллекцию/);
  let call=0;await expect(fetchLinearSnapshot("owner",["child"],async()=>({organization:{id:++call===1?"A":"B"},issue:issue(call===1?"child":"root",call===1?"root":null,[])}))).rejects.toThrow(/пространство/);
 });
 it("rejects stuck pagination and duplicate collection records",async()=>{
  const root:any=issue("root",null,[]);root.comments=conn([{id:"same"}],"cursor");
  await expect(fetchLinearSnapshot("owner",["root"],async(_,q)=>q.includes("Collection")?{issue:{comments:conn([{id:"same"}])}}:{organization:{id:"W"},issue:structuredClone(root)})).rejects.toThrow(/дубли/);
 });
 it("list exposes pagination cursor and never changes source",async()=>{
  const r=await listLinearIssues("owner","previous",async(_,q,v)=>{expect(v).toEqual({after:"previous"});expect(q).toMatch(/includeArchived: true/);return{organization:{id:"W"},issues:conn([{id:"issue"}],"next")};});expect(r.cursor).toBe("next");
 });
});

describe("fixed Composio Linear transport",()=>{
 it("uses the common account and refuses external mutation",async()=>{
  const {readLinearComposio}=await import("../scripts/composio_mcp.mjs");
  const {vi}=await import("vitest");
  const execute=vi.fn(async()=>({successful:true,data:{data:{organization:{id:"W"}}}}));
  const list=vi.fn(async()=>({items:[{id:"connected-common-account"}]}));
  const fake={connectedAccounts:{list},tools:{execute}};
  expect(await readLinearComposio(fake,"taskflow:owner",{query:"query Workspace { organization { id } }",variables:{}})).toEqual({data:{organization:{id:"W"}}});
  expect(list).toHaveBeenCalledWith({userIds:["taskflow:owner"],toolkitSlugs:["linear"],statuses:["ACTIVE"],limit:2});
  expect(execute).toHaveBeenCalledWith("LINEAR_RUN_QUERY_OR_MUTATION",expect.objectContaining({userId:"taskflow:owner",connectedAccountId:"connected-common-account",version:"20260924_00"}));
  await expect(readLinearComposio(fake,"taskflow:owner",{query:"mutation Update { issueUpdate { success } }"})).rejects.toThrow(/read_only/);
  expect(execute).toHaveBeenCalledTimes(1);
 });
 it("returns explicit disconnected, ambiguous and partial GraphQL errors",async()=>{
  const {readLinearComposio}=await import("../scripts/composio_mcp.mjs");const input={query:"query Read { organization { id } }"};
  expect(await readLinearComposio({connectedAccounts:{list:async()=>({items:[]})}},"owner",input)).toEqual({error:"not_connected"});
  expect(await readLinearComposio({connectedAccounts:{list:async()=>({items:[{id:"a"},{id:"b"}]})}},"owner",input)).toEqual({error:"multiple_accounts"});
  const fake={connectedAccounts:{list:async()=>({items:[{id:"a"}]})},tools:{execute:async()=>({successful:true,data:{data:{some:"partial"},errors:[{message:"secret request details"}]}})}};
  expect(await readLinearComposio(fake,"owner",input)).toEqual({error:"query_failed"});
 });
});
