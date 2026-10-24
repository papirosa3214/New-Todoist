// Разбор строки активности и решение «звать ли модель на телефоне».
//
// Тесты на чистые функции, а не на хук: React-состояние здесь ничего не
// решает, а вот эти четыре правила решают всё — по ним видно, покажется ли
// владельцу человеческая фраза или сырьё, и не сядет ли батарея от вызовов
// модели на каждое действие агента.
import { describe, it, expect } from "vitest";
import {
  EXPLAIN_EVERY_MS,
  actionOf,
  explainInput,
  mergeExplained,
  shouldExplain,
  stepOf,
} from "./useTaskActivity";

const DIFF = "export function searchNotes(q: string) { return q.trim(); }";

describe("разбор строки «шаг · действие»", () => {
  it("делит на шаг и действие", () => {
    const text = "Вернуть потерянные хвосты · правит src/lib/search.ts";
    expect(stepOf(text)).toBe("Вернуть потерянные хвосты");
    expect(actionOf(text)).toBe("правит src/lib/search.ts");
  });

  it("без разделителя считает всю строку действием", () => {
    // Сервер не добавляет название шага, когда ни один шаг не в работе
    // (runningStepTitle вернул null) — строка приходит одним куском.
    expect(stepOf("правит src/lib/search.ts")).toBeUndefined();
    expect(actionOf("правит src/lib/search.ts")).toBe("правит src/lib/search.ts");
  });

  it("не путается, если разделитель встречается в самом действии", () => {
    const text = "Шаг · запускает: git log --oneline · head";
    expect(stepOf(text)).toBe("Шаг");
    expect(actionOf(text)).toBe("запускает: git log --oneline · head");
  });
});

describe("подстановка фразы модели", () => {
  it("сохраняет название шага и меняет только действие", () => {
    // Шаг — факт с сервера, модель его заменять не должна: она объясняет
    // действие, а не переименовывает работу.
    const text = "Вернуть хвосты · правит src/lib/search.ts";
    expect(mergeExplained(text, "дописывает обрезку хвоста")).toBe(
      "Вернуть хвосты · дописывает обрезку хвоста",
    );
  });

  it("без шага показывает одну фразу модели", () => {
    expect(mergeExplained("правит src/lib/search.ts", "чинит поиск")).toBe(
      "чинит поиск",
    );
  });
});

describe("когда звать модель", () => {
  const now = 1_000_000;

  it("зовёт на правку с куском изменения", () => {
    expect(shouldExplain({ kind: "edit", diff: DIFF }, 0, now)).toBe(true);
  });

  it("молчит на чтении: объяснять нечего", () => {
    expect(shouldExplain({ kind: "read", diff: DIFF }, 0, now)).toBe(false);
  });

  it("молчит без куска правки", () => {
    // Без диффа модель начнёт выдумывать по имени файла — это хуже честной
    // строки от сервера, ради которой всё и делалось.
    expect(shouldExplain({ kind: "edit" }, 0, now)).toBe(false);
    expect(shouldExplain({ kind: "edit", diff: "  \n " }, 0, now)).toBe(false);
    expect(shouldExplain({ kind: "edit", diff: "x = 1" }, 0, now)).toBe(false);
  });

  it("держит паузу между вызовами", () => {
    // Модель считает на телефоне: без паузы пачка правок посадит батарею.
    const event = { kind: "edit" as const, diff: DIFF };
    expect(shouldExplain(event, now - 1000, now)).toBe(false);
    expect(shouldExplain(event, now - EXPLAIN_EVERY_MS, now)).toBe(true);
  });
});

describe("вход для модели", () => {
  it("склеивает действие и кусок правки", () => {
    const event = { text: "Шаг · правит src/lib/search.ts", diff: DIFF };
    expect(explainInput(event)).toBe(`правит src/lib/search.ts\n${DIFF}`);
  });

  it("без диффа отдаёт одно действие", () => {
    expect(explainInput({ text: "Шаг · правит a.ts" })).toBe("правит a.ts");
  });
});
