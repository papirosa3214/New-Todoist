// Юнит-тесты чистого парсера диктовки — без React, без сети, без DOM.
// Фиксированное "сегодня" передаётся вторым аргументом, чтобы тесты не
// зависели от системных часов и дня недели, в который их запускают.
import { describe, expect, it } from "vitest";
import {
  combineDictatedText,
  findProjectByName,
  parseDictation,
} from "./dictationParser";

// Суббота, 15 августа 2026 — выбрана намеренно как известный день недели,
// чтобы тесты на «в понедельник» и т.п. были детерминированы.
const SATURDAY = new Date(2026, 7, 15); // месяцы в Date 0-based → август = 7

describe("parseDictation — маркер метки", () => {
  it("вырезает @Метку, заголовок остаётся читаемым", () => {
    const r = parseDictation("Купить лампочки @Дом", SATURDAY);
    expect(r.title).toBe("Купить лампочки");
    expect(r.labelName).toBe("Дом");
  });

  it("метка вместе с проектом, приоритетом и датой", () => {
    const r = parseDictation(
      "Позвонить завтра #Работа @Важно !срочно",
      SATURDAY,
    );
    expect(r.title).toBe("Позвонить");
    expect(r.projectName).toBe("Работа");
    expect(r.labelName).toBe("Важно");
    expect(r.priority).toBe(1);
    expect(r.dueDate).toBe("2026-08-16");
  });

  it("хвостовая пунктуация после метки не попадает в имя", () => {
    const r = parseDictation("Полить цветы @Дом, вечером", SATURDAY);
    expect(r.labelName).toBe("Дом");
    expect(r.title).toBe("Полить цветы, вечером");
  });

  it("нескольких меток берётся первая, остальные не мусорят в заголовке", () => {
    const r = parseDictation("Разобрать почту @Работа @Срочно", SATURDAY);
    expect(r.labelName).toBe("Работа");
    expect(r.title).toBe("Разобрать почту");
  });

  it("без маркера метки поле пустое", () => {
    const r = parseDictation("Обычная задача без маркеров", SATURDAY);
    expect(r.labelName).toBeNull();
  });
});

describe("parseDictation — маркеры проекта и приоритета", () => {
  it("вырезает #Проект и !приоритет, заголовок остаётся читаемым", () => {
    const r = parseDictation("Позвонить завтра #Работа !срочно", SATURDAY);
    expect(r.title).toBe("Позвонить");
    expect(r.projectName).toBe("Работа");
    expect(r.priority).toBe(1);
    expect(r.dueDate).toBe("2026-08-16");
  });

  it("маркеры в другом порядке — тоже работает", () => {
    const r = parseDictation("!важно #Дом Купить лампочки", SATURDAY);
    expect(r.title).toBe("Купить лампочки");
    expect(r.projectName).toBe("Дом");
    expect(r.priority).toBe(2);
  });

  it("хвостовая пунктуация после маркера не попадает в имя", () => {
    const r = parseDictation("Сделать отчёт #Работа, срочно нужно", SATURDAY);
    expect(r.projectName).toBe("Работа");
    expect(r.title).toBe("Сделать отчёт, срочно нужно");
  });

  it("короткая цифровая форма приоритета !1..!4", () => {
    expect(parseDictation("Задача !1", SATURDAY).priority).toBe(1);
    expect(parseDictation("Задача !4", SATURDAY).priority).toBe(4);
    expect(parseDictation("Задача !p2", SATURDAY).priority).toBe(2);
  });

  it("неизвестное слово после ! — priority=null, и текст НЕ съедается", () => {
    // «!молоко» — не приоритет и не мусор, а часть заголовка пользователя;
    // молча стереть «молоко» вместе с нераспознанным маркером было бы
    // разрушительно и незаметно — хуже, чем просто не сработавший разбор.
    const r = parseDictation("Купить !молоко", SATURDAY);
    expect(r.priority).toBeNull();
    expect(r.title).toBe("Купить !молоко");
  });

  it("нет маркеров — заголовок не меняется вообще", () => {
    const r = parseDictation("Обычная задача без всего", SATURDAY);
    expect(r.title).toBe("Обычная задача без всего");
    expect(r.projectName).toBeNull();
    expect(r.priority).toBeNull();
    expect(r.dueDate).toBeNull();
  });
});

describe("parseDictation — относительные даты", () => {
  it("сегодня", () => {
    expect(parseDictation("Позвонить сегодня", SATURDAY).dueDate).toBe(
      "2026-08-15",
    );
  });

  it("завтра", () => {
    expect(parseDictation("Позвонить завтра", SATURDAY).dueDate).toBe(
      "2026-08-16",
    );
  });

  it("послезавтра — и не путается с «завтра» внутри слова", () => {
    const r = parseDictation("Сделать послезавтра", SATURDAY);
    expect(r.dueDate).toBe("2026-08-17");
    expect(r.title).toBe("Сделать");
  });

  it("через N дней — разные грамматические формы", () => {
    expect(parseDictation("Через 1 день позвонить", SATURDAY).dueDate).toBe(
      "2026-08-16",
    );
    expect(parseDictation("Через 2 дня позвонить", SATURDAY).dueDate).toBe(
      "2026-08-17",
    );
    expect(parseDictation("Через 10 дней позвонить", SATURDAY).dueDate).toBe(
      "2026-08-25",
    );
  });

  it("день недели — ближайший будущий, не сегодня, даже если сегодня совпадает", () => {
    // SATURDAY = суббота 15.08.2026. "в субботу" → ближайшая БУДУЩАЯ суббота,
    // то есть через неделю, а не сегодняшний день (сознательное решение,
    // см. комментарий в dictationParser.ts).
    expect(parseDictation("Сделать в субботу", SATURDAY).dueDate).toBe(
      "2026-08-22",
    );
  });

  it("день недели БЕЗ предлога «в/во» — НЕ дата, предлог обязателен", () => {
    // Без обязательного предлога голое имя дня недели слишком легко
    // оказывается частью обычного текста, никак не связанного с датой —
    // «настроить среду разработки» не должно терять половину заголовка.
    const r = parseDictation("Настроить среду разработки", SATURDAY);
    expect(r.dueDate).toBeNull();
    expect(r.title).toBe("Настроить среду разработки");
  });

  it("день недели — вторник через предлог «во»", () => {
    // Суббота 15.08 → ближайший будущий вторник = 18.08.
    expect(parseDictation("Сделать во вторник", SATURDAY).dueDate).toBe(
      "2026-08-18",
    );
  });
});

describe("parseDictation — абсолютные даты", () => {
  it("«15 августа» без года — берёт текущий год, если дата ещё не прошла", () => {
    const r = parseDictation("Оплатить 20 августа", SATURDAY);
    expect(r.dueDate).toBe("2026-08-20");
    expect(r.title).toBe("Оплатить");
  });

  it("«15 августа» без года — если дата уже прошла в этом году, берёт следующий", () => {
    const r = parseDictation("Оплатить 1 августа", SATURDAY);
    expect(r.dueDate).toBe("2027-08-01");
  });

  it("сокращённое название месяца «15 авг»", () => {
    expect(parseDictation("Сделать 20 авг", SATURDAY).dueDate).toBe(
      "2026-08-20",
    );
  });

  it("абсолютная дата с явным годом", () => {
    expect(parseDictation("Сделать 1 сентября 2030", SATURDAY).dueDate).toBe(
      "2030-09-01",
    );
  });

  it("числовой формат DD.MM", () => {
    expect(parseDictation("Сделать 20.08", SATURDAY).dueDate).toBe(
      "2026-08-20",
    );
  });

  it("числовой формат DD.MM.YYYY", () => {
    expect(parseDictation("Сделать 01.09.2030", SATURDAY).dueDate).toBe(
      "2030-09-01",
    );
  });

  it("числовой формат DD.MM.YY (двузначный год)", () => {
    expect(parseDictation("Сделать 01.09.30", SATURDAY).dueDate).toBe(
      "2030-09-01",
    );
  });
});

describe("parseDictation — не ломает обычный ручной ввод", () => {
  it("текст без единого маркера/даты возвращается как есть (с обрезкой пробелов)", () => {
    const r = parseDictation("  Купить молоко и хлеб  ", SATURDAY);
    expect(r.title).toBe("Купить молоко и хлеб");
    expect(r.dueDate).toBeNull();
    expect(r.projectName).toBeNull();
    expect(r.priority).toBeNull();
  });

  it("реальный полный пример из ТЗ целиком", () => {
    const r = parseDictation("Позвонить завтра #Работа !срочно", SATURDAY);
    expect(r).toEqual({
      title: "Позвонить",
      dueDate: "2026-08-16",
      startTime: null,
      projectName: "Работа",
      // Маркера метки в этой фразе нет — поле должно быть именно null, а не
      // отсутствовать: разбор всегда возвращает полный набор полей.
      labelName: null,
      priority: 1,
    });
  });
});

describe("findProjectByName", () => {
  const projects = [
    { id: "p1", name: "Работа" },
    { id: "p2", name: "Дом " },
  ];

  it("находит проект без учёта регистра", () => {
    expect(findProjectByName(projects, "работа")?.id).toBe("p1");
    expect(findProjectByName(projects, "РАБОТА")?.id).toBe("p1");
  });

  it("находит проект с обрезкой пробелов на обеих сторонах", () => {
    expect(findProjectByName(projects, "Дом")?.id).toBe("p2");
  });

  it("не находит — undefined, без выброса исключения", () => {
    expect(findProjectByName(projects, "Отпуск")).toBeUndefined();
  });

  it("null-имя — сразу undefined", () => {
    expect(findProjectByName(projects, null)).toBeUndefined();
  });
});

describe("combineDictatedText — вставка из кнопки микрофона", () => {
  it("пустой заголовок — просто подставляет распознанный текст", () => {
    expect(combineDictatedText("", "Купить молоко")).toBe("Купить молоко");
  });

  it("непустой заголовок — дописывает через пробел", () => {
    expect(combineDictatedText("Купить молоко", "завтра")).toBe(
      "Купить молоко завтра",
    );
  });

  it("лишние пробелы по краям обеих частей не остаются", () => {
    expect(combineDictatedText("  Купить молоко  ", "  завтра  ")).toBe(
      "Купить молоко завтра",
    );
  });

  it("пустое распознавание (тишина/шум) — заголовок не трогает", () => {
    expect(combineDictatedText("Купить молоко", "")).toBe("Купить молоко");
    expect(combineDictatedText("Купить молоко", "   ")).toBe("Купить молоко");
  });
});
