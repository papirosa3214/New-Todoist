// Наводящая строка карточки «Входящих» (владелец 29.10.2026).
//
// Карточка во «Входящих» должна сама отвечать на вопрос «что делать» —
// иначе владелец каждую задачу открывает и вникает в неё заново. Строка
// собирается сервером из живых данных задачи; телефон её только рисует.
import { describe, expect, it } from "vitest";
import { attentionHint, descriptionLine, HINT_LIMIT } from "../src/lib/attentionContext.js";
import type { AttentionContext } from "../src/lib/attentionContext.js";

const ctx = (patch: Partial<AttentionContext> = {}): AttentionContext => ({
  group: "blocked",
  title: null,
  blockedReason: null,
  clarificationQuestion: null,
  openStepTitle: null,
  openStepResult: null,
  activeStepTitle: null,
  verdictResult: null,
  lastStepTitle: null,
  lastStepResult: null,
  description: null,
  ...patch,
});

describe("наводящая строка карточки «Входящих»", () => {
  it("вопрос роли важнее прочих источников — ждёт ответа владельца", () => {
    const hint = attentionHint(
      ctx({
        clarificationQuestion: "Уточните исполнителя результата перед согласованием плана.",
        blockedReason: "Проверка заблокирована: 3 захода без вердикта.",
      }),
    );
    expect(hint).toBe("Нужен ваш ответ: Уточните исполнителя результата перед согласованием плана.");
  });

  it("заблокированная задача показывает причину блокировки", () => {
    const hint = attentionHint(
      ctx({
        group: "blocked",
        blockedReason: "Проверка заблокирована: 3 захода без вердикта; нужно решение владельца.",
        openStepResult: "changes_requested: Блокирующий дефект — сценарий не воспроизводится.",
      }),
    );
    expect(hint).toBe("Проверка заблокирована: 3 захода без вердикта; нужно решение владельца.");
  });

  it("причина блокировки важнее вердикта и в других группах: задача «На проверке» тоже ждёт решения владельца", () => {
    const hint = attentionHint(
      ctx({
        group: "review",
        blockedReason: "Достигнут лимит доработок плана — требуется решение владельца.",
        verdictResult: "approved: Ограничения, не блокирующие приёмку.",
      }),
    );
    expect(hint).toBe("Достигнут лимит доработок плана — требуется решение владельца.");
  });

  it("заблокированная задача без причины показывает результат незакрытого шага", () => {
    const hint = attentionHint(
      ctx({
        group: "blocked",
        openStepResult: "changes_requested: Блокирующий дефект — сценарий не воспроизводится.",
        openStepTitle: "Вердикт по живой проверке",
      }),
    );
    expect(hint).toBe("changes_requested: Блокирующий дефект — сценарий не воспроизводится.");
  });

  it("задача в работе показывает текущий шаг", () => {
    const hint = attentionHint(
      ctx({
        group: "in_progress",
        activeStepTitle: "Техническое решение и риски",
        openStepTitle: "Реализация",
      }),
    );
    expect(hint).toBe("Техническое решение и риски");
  });

  it("задача на проверке показывает вердикт проверки", () => {
    const hint = attentionHint(
      ctx({
        group: "review",
        verdictResult: "approved: Проверено по артефактам, а не по отчёту роли.",
        lastStepResult: "Сводка принята и готова к переносу в основную ветку.",
      }),
    );
    expect(hint).toBe("approved: Проверено по артефактам, а не по отчёту роли.");
  });

  it("задача на проверке без вердикта показывает результат последнего закрытого шага", () => {
    const hint = attentionHint(
      ctx({
        group: "review",
        lastStepResult: "Сводка принята и готова к переносу в основную ветку.",
        lastStepTitle: "Интеграция принятого результата",
      }),
    );
    expect(hint).toBe("Сводка принята и готова к переносу в основную ветку.");
  });

  it("когда своих данных нет — берётся первая часть описания без заголовка раздела", () => {
    const hint = attentionHint(
      ctx({
        group: "review",
        description: "## Работа\n\nЧат агента работает не так, как задумано.\n\n## Результат\n\nВсё хорошо.",
      }),
    );
    expect(hint).toBe("Чат агента работает не так, как задумано.");
  });

  it("описание, повторяющее название задачи, строкой не становится", () => {
    const hint = attentionHint(
      ctx({
        group: "review",
        title: "1. Единый допуск запуска, восстановление и отсечение устаревших событий",
        description: "## Работа\n\n4. Единый допуск запуска, восстановление и отсечение устаревших событий",
      }),
    );
    expect(hint).toBeNull();
  });

  it("шаг, названный как задача, строкой не становится", () => {
    const hint = attentionHint(
      ctx({
        group: "blocked",
        title: "1. Единый допуск запуска, восстановление и отсечение устаревших событий",
        openStepTitle: "4. Единый допуск запуска, восстановление и отсечение устаревших событий",
      }),
    );
    expect(hint).toBeNull();
  });

  it("нет ни своих данных, ни описания — строки нет", () => {
    expect(attentionHint(ctx())).toBeNull();
  });

  it("строка всегда одна: переводы строк склеены, длинный текст обрезан", () => {
    const hint = attentionHint(
      ctx({
        group: "blocked",
        blockedReason: "Первая строка\nвторая строка\nтретья строка",
      }),
    );
    expect(hint).toBe("Первая строка вторая строка третья строка");

    const long = attentionHint(ctx({ group: "blocked", blockedReason: "я".repeat(400) }));
    expect(long).not.toBeNull();
    expect((long ?? "").length).toBeLessThanOrEqual(HINT_LIMIT + 1);
    expect(long?.endsWith("…")).toBe(true);
  });

  it("описание без разделов берётся целиком по первой части", () => {
    expect(descriptionLine("Просто описание задачи")).toBe("Просто описание задачи");
    expect(descriptionLine("## Работа\n\nТекст")).toBe("Текст");
    expect(descriptionLine(null)).toBeNull();
    expect(descriptionLine("")).toBeNull();
  });
});
