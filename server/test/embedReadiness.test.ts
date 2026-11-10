// Готовность эмбеддингов — чистая классификация, без Ollama и видеокарты.
import { describe, expect, it } from "vitest";
import { classifyEmbedReadiness } from "../src/lib/embedReadiness.js";

const model = "bge-m3-embed:latest";

describe("готовность эмбеддингов", () => {
  it("модель не загружена — с базой работать нельзя", () => {
    const result = classifyEmbedReadiness({ model, reachable: true, loaded: ["other:latest"], gpuUtil: 0 });
    expect(result).toMatchObject({ state: "down", loaded: false, label: "Эмбеддинги не загружены" });
  });

  it("суффикс :latest не мешает узнать загруженную модель", () => {
    const bare = classifyEmbedReadiness({ model, reachable: true, loaded: ["bge-m3-embed"], gpuUtil: null });
    const tagged = classifyEmbedReadiness({ model: "bge-m3-embed", reachable: true, loaded: ["bge-m3-embed:latest"], gpuUtil: 69 });
    expect(bare).toMatchObject({ state: "ready", loaded: true, label: "Эмбеддинги готовы" });
    expect(tagged.state).toBe("ready");
  });

  it("модель загружена, но видеокарта занята — поиск подождёт", () => {
    const result = classifyEmbedReadiness({ model, reachable: true, loaded: ["bge-m3-embed:latest"], gpuUtil: 70 });
    expect(result).toMatchObject({ state: "busy", loaded: true, gpu_util: 70, label: "Эмбеддинги заняты — поиск подождёт" });
  });

  it("Ollama не отвечает", () => {
    const result = classifyEmbedReadiness({ model, reachable: false, loaded: ["bge-m3-embed:latest"], gpuUtil: 10 });
    expect(result).toMatchObject({ state: "down", loaded: false, label: "Эмбеддинги не отвечают" });
  });
});
