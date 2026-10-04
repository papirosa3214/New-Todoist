import {describe,it,expect} from "vitest";
import {builderXcodeAllowed,connectBuilderXcode} from "../src/runtime/builderXcode.js";
describe("выделенный MCP MacBook",()=>{
 for(const role of ["researcher","analyst","architect","qa","critic_verifier"])
  it("не предоставляет Xcode роли "+role,async()=>expect((await connectBuilderXcode(role,"work")).tools).toEqual([]));
 it("builder получает доступ только в режиме work",()=>{
  expect(builderXcodeAllowed("builder","work")).toBe(true);
  for(const mode of ["plan","review","reply","chat"])expect(builderXcodeAllowed("builder",mode)).toBe(false);
 });
 it("без конфига builder сохраняет обычный запуск",async()=>expect((await connectBuilderXcode("builder","work")).tools).toEqual([]));
});
