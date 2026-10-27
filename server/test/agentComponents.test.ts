import { describe, expect, it } from "vitest";
import { componentsOfStructured, componentOfWidget } from "../src/lib/agentComponents.js";
import { chatBlocks } from "../src/lib/chatBlocks.js";

describe("agentComponents: один формат «компонент + данные»", () => {
  it("виджет: имя — его type, данные — сам JSON", () => {
    expect(componentOfWidget({ type: "metrics", items: [{ label: "a", value: 1 }] }))
      .toEqual({ name: "metrics", props: { type: "metrics", items: [{ label: "a", value: 1 }] } });
  });

  it("виджет без type или не объект — компонента нет", () => {
    expect(componentOfWidget({ items: [] })).toBeNull();
    expect(componentOfWidget([1, 2])).toBeNull();
  });

  it("tf-json: каждый блок output — компонент; widget внутри разворачивается в свой компонент", () => {
    const envelope = { schema_version: 1, ok: true, output: [
      { type: "heading", text: "Итог" },
      { type: "widget", widget: { type: "progress", items: [] } },
      { type: "widget" },
    ] };
    expect(componentsOfStructured(envelope)).toEqual([
      { name: "heading", props: { type: "heading", text: "Итог" } },
      { name: "progress", props: { type: "progress", items: [] } },
    ]);
  });

  it("tf-json с output-текстом — компонентов нет", () => {
    expect(componentsOfStructured({ ok: true, output: "просто текст" })).toBeNull();
  });

  it("chatBlocks: старые поля на месте, рядом component / components", () => {
    const [w] = chatBlocks("```widget\n{\"type\":\"card\",\"title\":\"T\"}\n```") as any[];
    expect(w.type).toBe("widget");
    expect(JSON.parse(w.json).title).toBe("T");
    expect(w.component).toMatchObject({ name: "card", props: { type: "card", title: "T" } });

    const [s] = chatBlocks("```tf-json\n{\"ok\":true,\"output\":[{\"type\":\"status\",\"code\":\"done\"}]}\n```") as any[];
    expect(s.type).toBe("structured_json");
    expect(s.components).toEqual([{ name: "status", props: { type: "status", code: "done" } }]);
  });

  it("битый JSON — блок как раньше, без компонента", () => {
    const [w] = chatBlocks("```widget\n{oops\n```") as any[];
    expect(w).toEqual({ type: "widget", json: "{oops" });
  });
});
