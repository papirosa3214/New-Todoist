// 13.11.2026. Куски stdio и тел запросов декодировались по одному
// (`chunk.toString("utf8")`), поэтому многобайтная буква, попавшая на
// границу кусков, превращалась в два U+FFFD — «Корневог�� README.md».
// Декодер держит неполный хвост до следующего куска.
import { describe, expect, it } from "vitest";
import { createUtf8StreamDecoder } from "../src/lib/utf8Stream.js";

/** Режет строку на куски Buffer ровно в заданных байтовых позициях. */
function sliceBytes(text: string, cuts: number[]): Buffer[] {
  const all = Buffer.from(text, "utf8");
  const pieces: Buffer[] = [];
  let from = 0;
  for (const cut of [...cuts, all.length]) {
    pieces.push(all.subarray(from, cut));
    from = cut;
  }
  return pieces;
}

describe("createUtf8StreamDecoder", () => {
  it("буква, разорванная на границе кусков, не превращается в U+FFFD", () => {
    const text = "Корневого README.md в репозитории";
    // Проверяем каждый возможный разрез: любой из них может оказаться
    // границей кусков (так и появилось «Корневог��»).
    const total = Buffer.from(text, "utf8").length;
    for (let cut = 1; cut < total; cut += 1) {
      const decoder = createUtf8StreamDecoder();
      let out = "";
      for (const piece of sliceBytes(text, [cut])) out += decoder.write(piece);
      out += decoder.end();
      expect(out).toBe(text);
      expect(out.includes("\ufffd")).toBe(false);
    }
  });

  it("держит двухбайтную, трёхбайтную и четырёхбайтную букву", () => {
    const text = "Ёж 🦔 в тумане";
    const decoder = createUtf8StreamDecoder();
    const all = Buffer.from(text, "utf8");
    let out = "";
    // По одному байту за кусок — худший случай.
    for (let i = 0; i < all.length; i += 1) out += decoder.write(all.subarray(i, i + 1));
    out += decoder.end();
    expect(out).toBe(text);
  });

  it("строковый кусок (setEncoding) проходит как есть", () => {
    const decoder = createUtf8StreamDecoder();
    expect(decoder.write(Buffer.from("Корнево", "utf8"))).toBe("Корнево");
    expect(decoder.write("го")).toBe("го");
    expect(decoder.end()).toBe("");
  });

  it("end() отдаёт U+FFFD только для по-настоящему обрезанного хвоста", () => {
    const decoder = createUtf8StreamDecoder();
    const bytes = Buffer.from("ок", "utf8");
    expect(decoder.write(bytes.subarray(0, 1))).toBe("");
    expect(decoder.end()).toBe("\ufffd");
  });
});
