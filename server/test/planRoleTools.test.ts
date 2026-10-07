import { describe, expect, it } from "vitest";
import { taskflowTools } from "../src/runtime/inProcessRun.js";
describe("достройка плана в рабочем runtime", () => {
  it.each(["analyst", "architect", "builder", "designer", "researcher", "qa", "critic_verifier", "synthesizer"])("%s получает инструмент в собственном слоте", role => {
    const tools = taskflowTools(role, null, "task", "step");
    expect(tools.map(t => t.name)).toContain("taskflow_plan_request");
    expect(tools.map(t => t.name)).not.toContain("taskflow_claim");
  });
  it("инструмент привязан к текущему слоту, даже если другая подзадача той же роли", async () => {
    const tool=taskflowTools("builder",null,"task","own").find(t=>t.name==="taskflow_plan_request")!;
    await expect(tool.execute("foreign",{subtask_id:"foreign",kind:"add_step",reason:"x",role:"qa",expected_result:"x"})).rejects.toThrow("текущего слота");
  });
});
