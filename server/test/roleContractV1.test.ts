import { beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
vi.mock("../src/runtime/inProcessRun.js", async original => ({...await original<any>(), runRoleInProcess: vi.fn(async()=>({runId:"contract-v1-test",completion:Promise.resolve()}))}));
import {
  normalizeRoleContractV1,
  normalizeRoleReplyV1,
  parseRoleContractV1,
  ROLE_CONTRACT_V1,
  unwrapRoleEnvelopeText,
  validateRoleContractV1,
  validateStructuredRoleContractV1,
} from "../src/lib/roleContractV1.js";
import { unwrapRoleEnvelope } from "../src/runtime/chatLiveTurn.js";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { formatChatMessage } from "../src/lib/chatMessages.js";
import { roleUserId } from "../src/roleRouting.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

// Карточка 237d6f34 «Внедрить JSON-контракт роли v1 на сервере»: валидатор
// конверта, совместимость старого YAML-подобного вида и доставка конверта в
// чат и на путь сдачи этапа.

describe("нормализация финального ответа в JSON v1", () => {
  it("сохраняет валидный структурированный ответ без изменений", () => {
    const source = {
      schema_version: 1, ok: true, output: [{ type: "heading", text: "Итог", level: 1 }, { type: "text", text: "Готово." }],
      artifacts: [], plan_artifact: null, error: null, next_hint: null, needs_human: false,
    };
    const normalized = normalizeRoleReplyV1(JSON.stringify(source));
    expect(normalized.normalizedByServer).toBe(false);
    expect(normalized.envelope).toEqual(source);
    expect(normalized.displayText).toContain("Готово.");
    expect(validateStructuredRoleContractV1(normalized.envelope).valid).toBe(true);
  });

  it("оборачивает обычный текст в разрешённый text-блок и сохраняет его", () => {
    const normalized = normalizeRoleReplyV1("Ответ без конверта.");
    expect(normalized.normalizedByServer).toBe(true);
    expect(normalized.validationErrors).toContain("Ответ не содержит JSON v1 конверт");
    expect(normalized.envelope.output).toEqual([{ type: "text", text: "Ответ без конверта." }]);
    expect(normalized.displayText).toBe("Ответ без конверта.");
    expect(validateStructuredRoleContractV1(normalized.envelope).valid).toBe(true);
  });

  // Сырой конверт владельцу не показывается (владелец 27.10.2026): вместо
  // него — что вынулось из полей text, иначе пометка о сбое контракта.
  it("битый JSON не доходит владельцу сырым: пометка о сбое", () => {
    const raw = '{"schema_version":1,"output":';
    const normalized = normalizeRoleReplyV1(raw);
    expect(normalized.normalizedByServer).toBe(true);
    expect(normalized.displayText).not.toContain("schema_version");
    expect(normalized.displayText).toContain("не прошёл проверку контракта");
    expect(validateStructuredRoleContractV1(normalized.envelope).valid).toBe(true);
  });

  it("переводит старый конверт и сохраняет материалы", () => {
    const normalized = normalizeRoleReplyV1(JSON.stringify({
      ok: true, output: "Отчёт готов.", artifacts: ["https://example.test/report"], error: null, next_hint: null, needs_human: false,
    }));
    expect(normalized.envelope).toMatchObject({
      schema_version: 1, ok: true, output: [{ type: "text", text: "Отчёт готов." }],
      artifacts: [{ kind: "artifact", ref: "https://example.test/report" }],
    });
    expect(validateStructuredRoleContractV1(normalized.envelope).valid).toBe(true);
  });
});

describe("JSON-контракт роли v1: валидатор", () => {
  it("принимает полный конверт и приводит его к нормализованному виду", () => {
    const checked = validateRoleContractV1({
      ok: true,
      output: "Виджет нарисован, отчёт сдан.",
      artifacts: ["https://example.test/док", "  ", "https://example.test/кадр"],
      error: null,
      next_hint: "Перенести в main",
      needs_human: false,
    });
    expect(checked.valid).toBe(true);
    expect(checked.envelope).toEqual({
      contract: ROLE_CONTRACT_V1,
      ok: true,
      output: "Виджет нарисован, отчёт сдан.",
      artifacts: ["https://example.test/док", "https://example.test/кадр"],
      error: null,
      next_hint: "Перенести в main",
      needs_human: false,
    });
  });

  it("минимум — ok и output; остальные поля необязательны", () => {
    const checked = validateRoleContractV1({ ok: false, output: "Сбой сборки." });
    expect(checked.valid).toBe(true);
    expect(checked.envelope).toMatchObject({
      ok: false,
      artifacts: [],
      error: null,
      next_hint: null,
      needs_human: false,
    });
  });

  it.each([
    [{ output: "Есть текст" }, "ok"],
    [{ ok: true }, "output"],
    [{ ok: "true", output: "Строка вместо флага" }, "ok"],
    [{ ok: true, output: "   " }, "output"],
    [{ ok: true, output: "Текст", artifacts: 42 }, "artifacts"],
    [{ ok: true, output: "Текст", needs_human: "нет" }, "needs_human"],
    [{ ok: true, output: "Текст", error: { code: 1 } }, "error"],
    [{ ok: true, output: "Текст", next_hint: ["a"] }, "next_hint"],
    [{ ok: true, output: "Текст", contract: "role.v2" }, "contract"],
  ])("отклоняет битый конверт и объясняет поле: %j", (value, field) => {
    const checked = validateRoleContractV1(value);
    expect(checked.valid).toBe(false);
    expect(checked.envelope).toBeNull();
    expect(checked.errors.join(" ")).toContain(field);
  });

  it.each([[null], [42], ["ок"], [[]]])("не объект — не конверт: %j", (value) => {
    const checked = validateRoleContractV1(value);
    expect(checked.valid).toBe(false);
    expect(checked.errors).toHaveLength(1);
  });

  it("поле будущей версии — предупреждение, а не отказ", () => {
    const checked = validateRoleContractV1({ ok: true, output: "Текст", priority: "high" });
    expect(checked.valid).toBe(true);
    expect(checked.warnings.join(" ")).toContain("priority");
  });

  it("бросающая обёртка отдаёт конверт или понятную ошибку", () => {
    expect(normalizeRoleContractV1({ ok: true, output: "Готово" }).output).toBe("Готово");
    expect(() => normalizeRoleContractV1({ ok: true })).toThrow(/output/);
  });
});

describe("JSON-контракт роли v1: разбор ответа роли", () => {
  it("конверт JSON в блоке кода: владельцу показывается output", () => {
    const text = [
      "Сделано.",
      "```json",
      JSON.stringify({ ok: true, output: "Виджет нарисован.", artifacts: "https://example.test/док", needs_human: false }),
      "```",
      "Спросите, если что.",
    ].join("\n");
    const parsed = parseRoleContractV1(text);
    expect(parsed.format).toBe("v1");
    expect(parsed.text).toBe("Сделано.\nВиджет нарисован.\nСпросите, если что.");
    expect(parsed.envelope).toMatchObject({ contract: "role.v1", artifacts: ["https://example.test/док"] });
    expect(unwrapRoleEnvelope(text)).toBe(parsed.text);
  });

  it("конверт JSON без обрамления и с error/needs_human", () => {
    const parsed = parseRoleContractV1(
      JSON.stringify({ ok: false, output: "Перенос не выполнен.", error: "нет прав на main", next_hint: "Ждать владельца", needs_human: true }),
    );
    expect(parsed.format).toBe("v1");
    expect(parsed.envelope).toMatchObject({
      ok: false,
      error: "нет прав на main",
      next_hint: "Ждать владельца",
      needs_human: true,
    });
  });

  it("битый JSON-конверт не теряется: текст показан как есть, претензии рядом", () => {
    const text = '```json\n{"ok": "да", "output": "Текст"}\n```';
    const parsed = parseRoleContractV1(text);
    expect(parsed.format).toBe("v1");
    expect(parsed.envelope).toBeNull();
    expect(parsed.text).toBe(text);
    expect(parsed.errors.join(" ")).toContain("ok");
  });

  it("старый YAML-подобный конверт работает как раньше и тоже даёт v1-конверт", () => {
    const parsed = parseRoleContractV1("```\nok: true\noutput: |\n  Готово.\n  Дальше.\nartifacts: []\n```");
    expect(parsed.format).toBe("legacy");
    expect(parsed.text).toBe("Готово.\nДальше.");
    expect(parsed.envelope).toMatchObject({ contract: "role.v1", ok: true, artifacts: [] });

    const plain = parseRoleContractV1("ok: false\n\noutput: |\n Не смог.\nartifacts: null\nneeds_human: true");
    expect(plain.format).toBe("legacy");
    expect(plain.envelope).toMatchObject({ ok: false, output: "Не смог.", needs_human: true });
  });

  it("целевой JSON с типизированными блоками проходит проверку и становится полем envelope", () => {
    const value = {
      schema_version: 1, ok: true,
      output: [{ type: "text", text: "Результат готов." }, { type: "status", title: "Проверка", code: "passed" }, { type: "table", columns: ["Этап"], rows: [["1"]] }],
      artifacts: [], plan_artifact: null, error: null, next_hint: null, needs_human: false,
    };
    expect(validateStructuredRoleContractV1(value)).toMatchObject({ valid: true });
    const parsed = parseRoleContractV1(JSON.stringify(value));
    expect(parsed.text).toBe("Результат готов.\n\nПроверка\n\n| Этап |\n| --- |\n| 1 |");
    expect(parsed.structuredEnvelope).toEqual(value);
    expect(parsed.envelope).toBeNull();
  });

  it("неизвестный блок отклоняется, а неполный live JSON показывает только текстовый префикс", () => {
    const invalid = {
      schema_version: 1, ok: true, output: [{ type: "html", html: "<b>x</b>" }],
      artifacts: [], plan_artifact: null, error: null, next_hint: null, needs_human: false,
    };
    expect(validateStructuredRoleContractV1(invalid).valid).toBe(false);
    expect(unwrapRoleEnvelopeText('{"schema_version":1,"ok":true,"output":[{"type":"text","text":"Печатается \\u043e')).toBe("Печатается о");
  });

  // Владелец 21.10.2026: `needs_human` на сервере не обязателен — без него
  // «решение владельца не нужно». Раньше поле было обязательным, и роль, его
  // забывшая, отдавала владельцу сырой JSON вместо блоков.
  it("конверт без needs_human принимается и считается needs_human = false", () => {
    const withoutField = {
      schema_version: 1, ok: true, output: [{ type: "text", text: "Готово." }],
      artifacts: [], plan_artifact: null, error: null, next_hint: null,
    };
    const checked = validateStructuredRoleContractV1(withoutField);
    expect(checked.errors).toEqual([]);
    expect(checked.envelope?.needs_human).toBe(false);

    const parsed = parseRoleContractV1(JSON.stringify(withoutField));
    expect(parsed.format).toBe("v1");
    expect(parsed.structuredEnvelope?.needs_human).toBe(false);
    expect(parsed.text).toBe("Готово.");

    const normalized = normalizeRoleReplyV1(JSON.stringify(withoutField));
    expect(normalized.normalizedByServer).toBe(false);
    expect(normalized.envelope.needs_human).toBe(false);
    expect(normalized.displayText).toBe("Готово.");
  });

  it("needs_human = true сохраняется, а значение не boolean — ошибка", () => {
    const withFlag = {
      schema_version: 1, ok: true, output: [{ type: "text", text: "Нужно решение." }],
      artifacts: [], plan_artifact: null, error: null, next_hint: null, needs_human: true,
    };
    expect(validateStructuredRoleContractV1(withFlag).envelope?.needs_human).toBe(true);
    expect(validateStructuredRoleContractV1({ ...withFlag, needs_human: "да" }).errors.join(" ")).toMatch(/needs_human/);
  });

  it.each([
    ["Пример:\n```json\n{\"ok\": true}\n```", "JSON без output — не конверт"],
    ["Вот:\n```ts\nconst ok = true;\n```", "код не конверт"],
    ["```yaml\nok: maybe\n```", "не-конвертный ok"],
    ["Сервер ответил ok: true — всё хорошо.", "ok в прозе"],
    ["Просто ответ без полей.", "обычный текст"],
    ["", "пустой ответ"],
  ])("обычный ответ не меняется: %s", (text) => {
    expect(parseRoleContractV1(text).format).toBe("plain");
    expect(unwrapRoleEnvelope(text)).toBe(text);
  });

  it("недописанный конверт живого хода по-прежнему даёт пустой текст, а не сырой блок", () => {
    expect(unwrapRoleEnvelopeText("```\nok: true\noutput: |\n  Решение зафикс")).toBe("Решение зафикс");
    expect(unwrapRoleEnvelopeText("```\nok: true\nout")).toBe("");
    // Старый конверт и новый — одна функция: поведение прежнее.
    expect(unwrapRoleEnvelope("```\nok: true\noutput: |\n  Готово.\n```")).toBe("Готово.");
  });
});

describe("JSON-контракт роли v1: чат и сдача этапа", { timeout: 20000 }, () => {
  let app: any, owner: string, builder: string, project: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const u = (await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Contract owner", email: crypto.randomUUID() + "@test", password: "password123" } })).json();
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(u.user.id);
    owner = "Bearer " + u.token;
    builder = "Bearer " + app.jwt.sign({ id: roleUserId("builder") });
    project = (await app.inject({ method: "POST", url: "/api/projects", headers: { authorization: owner }, payload: { name: "Contract v1 project" } })).json().id;
  });

  const chatRow = (text: string) => ({
    id: crypto.randomUUID(),
    chat_id: "chat-contract-v1",
    from_user_id: roleUserId("builder"),
    message_type: "chat",
    text,
    task_id: null,
    subtask_id: null,
    reply_to_message_id: null,
    quick_replies: null,
    steps: null,
  });

  it("конверт роли доезжает в сообщение чата отдельным полем, текст остаётся человеческим", () => {
    const v1 = formatChatMessage(chatRow(JSON.stringify({ ok: true, output: "Виджет нарисован.", artifacts: ["https://example.test/док"], needs_human: false })));
    expect(v1.role_envelope).toEqual({ contract: "role.v1", ok: true, output: "Виджет нарисован.", artifacts: ["https://example.test/док"], error: null, next_hint: null, needs_human: false });
    expect(v1.text).toBe("Виджет нарисован.");

    const structured = formatChatMessage(chatRow(JSON.stringify({
      schema_version: 1, ok: true, output: [{ type: "text", text: "Блоковый результат." }],
      artifacts: [], plan_artifact: null, error: null, next_hint: null, needs_human: false,
    })));
    expect(structured.role_envelope).toMatchObject({ schema_version: 1, output: [{ type: "text", text: "Блоковый результат." }] });
    expect(structured.text).toBe("Блоковый результат.");

    const legacy = formatChatMessage(chatRow("```\nok: true\noutput: |\n  Старый вид.\n```"));
    expect(legacy.text).toBe("Старый вид.");
    expect(legacy.role_envelope).toMatchObject({ contract: "role.v1", output: "Старый вид." });

    const plain = formatChatMessage(chatRow("Просто ответ, без конверта."));
    expect(plain.text).toBe("Просто ответ, без конверта.");
    expect(plain.role_envelope).toBeNull();
  });

  async function fixture() {
    const task = (await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: owner }, payload: { title: "Конверт роли " + crypto.randomUUID(), project_id: project } })).json().task;
    const plan = (await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/collaboration-plans`,
      headers: { authorization: owner },
      payload: { profile: "manual", nodes: [{ slot_key: "work", role_key: "builder", expected_result: "Результат работы" }], edges: [] },
    })).json().plan;
    await app.inject({ method: "PATCH", url: `/api/tasks/${task.id}/integration-responsibility`, headers: { authorization: owner }, payload: { mode: "manual", owner_id: roleUserId("builder") } });
    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/collaboration-plans/${plan.id}/approve`, headers: { authorization: owner }, payload: {} });
    const step = (db.prepare("SELECT * FROM subtasks WHERE task_id=?").all(task.id) as any[]).find((s) => s.plan_node_key === "work");
    return { task, step };
  }

  const patch = (id: string, payload: any) => app.inject({ method: "PATCH", url: `/api/subtasks/${id}`, headers: { authorization: builder }, payload });

  const REPORT = [
    "## Результат",
    "Конверт роли внедрён.",
    "## Что сделано",
    "Валидатор и адаптер на сервере.",
    "## Проверки",
    "Прогон тестов на временной базе.",
    "## Ограничения",
    "Клиент конверт пока не рисует.",
    "## Материалы",
    "Коммит ветки роли.",
  ].join("\n\n");

  it("сдача с одним конвертом закрывает шаг: output становится итогом", async () => {
    const f = await fixture();
    const res = await patch(f.step.id, {
      done: true,
      report_markdown: REPORT,
      contract_v1: { ok: true, output: "Виджет нарисован, отчёт сдан.", artifacts: ["https://example.test/док"], needs_human: false },
    });
    if (res.statusCode !== 200) console.log("DEBUG-DONE", JSON.stringify(res.json()));
    expect(res.statusCode).toBe(200);
    expect(res.json().role_contract_v1).toMatchObject({ contract: "role.v1", output: "Виджет нарисован, отчёт сдан." });
    expect((db.prepare("SELECT result, done FROM subtasks WHERE id=?").get(f.step.id) as any)).toMatchObject({ result: "Виджет нарисован, отчёт сдан.", done: 1 });
    const receipt = (await app.inject({ method: "GET", url: `/api/subtasks/${f.step.id}/submission-receipt`, headers: { authorization: builder } })).json();
    expect(receipt).toMatchObject({ confirmed: true, authority: "primary" });
  });

  it("битый конверт отклоняется, а обычная сдача рядом с ним не ломается", async () => {
    const f = await fixture();
    const bad = await patch(f.step.id, { done: true, result: "Готово.", report_markdown: REPORT, contract_v1: { ok: "да", output: "Текст" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain("contract_v1");
    expect((db.prepare("SELECT done FROM subtasks WHERE id=?").get(f.step.id) as any).done).toBe(0);

    const good = await patch(f.step.id, { done: true, result: "Готово.", report_markdown: REPORT });
    expect(good.statusCode).toBe(200);
    expect(good.json().role_contract_v1).toBeUndefined();
    expect((db.prepare("SELECT result FROM subtasks WHERE id=?").get(f.step.id) as any).result).toBe("Готово.");
    expect((db.prepare("SELECT done FROM subtasks WHERE id=?").get(f.step.id) as any).done).toBe(1);
  });

  it("прежняя сдача с отчётом из пяти разделов не изменилась", async () => {
    const f = await fixture();
    const res = await patch(f.step.id, { done: true, result: "Конверт роли внедрён.", report_markdown: REPORT });
    expect(res.statusCode).toBe(200);
    const note = db.prepare("SELECT to_value AS id FROM task_events WHERE kind='role_result_report' AND field=? ORDER BY rowid DESC LIMIT 1").get(f.step.id) as any;
    expect(note?.id).toBeTruthy();
    const receipt = (await app.inject({ method: "GET", url: `/api/subtasks/${f.step.id}/submission-receipt`, headers: { authorization: builder } })).json();
    expect(receipt).toMatchObject({ confirmed: true, authority: "primary", document_id: note.id });
  });
});

describe("блоки command, link, widget и таблица (20.10.2026)", () => {
  const env = (output: any[]) => ({ schema_version: 1, ok: true, output, artifacts: [], plan_artifact: null, error: null, next_hint: null, needs_human: false });
  it("принимает и переводит в текст, который рисуют клиенты", async () => {
    const { validateStructuredRoleContractV1, structuredOutputText } = await import("../src/lib/roleContractV1.js");
    const blocks = [
      { type: "command", title: "Перезапуск", command: "systemctl --user restart taskflow-server" },
      { type: "link", title: "Проект", url: "https://example.com/a?b=1" },
      { type: "widget", widget: { type: "checklist", title: "Шаги", items: [{ text: "раз", done: true }] } },
      { type: "table", title: "T", columns: ["a", "b"], rows: [["1", "x|y"]] },
      { type: "chart", title: "C", kind: "bar", points: [{ label: "пн", value: 3 }] },
    ];
    expect(validateStructuredRoleContractV1(env(blocks)).errors).toEqual([]);
    const text = structuredOutputText(blocks);
    expect(text).toContain("```bash\nsystemctl --user restart taskflow-server\n```");
    expect(text).toContain("[Проект](https://example.com/a?b=1)");
    expect(text).toContain('```widget\n{"type":"checklist"');
    expect(text).toContain("| a | b |\n| --- | --- |\n| 1 | x\\|y |");
    expect(text).toContain('"points":[{"x":"пн","y":3}]');
  });
  it("отвергает ссылку не http(s), пустую команду и кривой виджет", async () => {
    const { validateStructuredRoleContractV1 } = await import("../src/lib/roleContractV1.js");
    const errors = validateStructuredRoleContractV1(env([
      { type: "link", title: "x", url: "javascript:alert(1)" },
      { type: "command", command: "  " },
      { type: "widget", widget: { type: "chart", title: "x", kind: "bar", points: [{ label: "a", value: 1 }] } },
    ])).errors.join("\n");
    expect(errors).toMatch(/output\[0\]\.url/);
    expect(errors).toMatch(/output\[1\]\.command/);
    expect(errors).toMatch(/output\[2\]\.widget/);
  });
  it("принимает внутреннюю ссылку на заметку note://<id> (23.10.2026)", async () => {
    const { validateStructuredRoleContractV1, ROLE_BLOCK_GUIDE } = await import("../src/lib/roleContractV1.js");
    // Владелец: «ссылку правильную давай на материал... чтобы по падении мог
    // сразу прочитать» — с телефона тап по ссылке открывает заметку в
    // приложении, а не веб-страницу.
    expect(validateStructuredRoleContractV1(env([
      { type: "link", title: "Отчёт по ветке", url: "note://f1dd193f-9ebf-4ecc-926c-04988bcc58c6" },
    ])).errors).toEqual([]);
    // Чужие схемы и подделки — по-прежнему мимо.
    const errors = validateStructuredRoleContractV1(env([
      { type: "link", title: "x", url: "task://evil/payload" },
      { type: "link", title: "y", url: "javascript:alert(1)" },
    ])).errors.join("\n");
    expect(errors).toMatch(/note:\/\/<id заметки>/);
    expect(ROLE_BLOCK_GUIDE.link).toContain("note://<id заметки>");
  });
});

describe("список блоков в инструкции — из схемы (20.10.2026)", () => {
  it("описан каждый тип валидатора, и только они", async () => {
    const { ROLE_BLOCK_GUIDE, roleBlockLines, validateStructuredRoleContractV1 } = await import("../src/lib/roleContractV1.js");
    const lines = roleBlockLines().split("\n");
    expect(lines.length).toBe(Object.keys(ROLE_BLOCK_GUIDE).length);
    for (const type of Object.keys(ROLE_BLOCK_GUIDE)) {
      const errors = validateStructuredRoleContractV1({ schema_version: 1, ok: true, output: [{ type }], artifacts: [], plan_artifact: null, error: null, next_hint: null, needs_human: false }).errors.join(" ");
      expect(errors).not.toMatch(/неизвестный тип блока/);
    }
  });
});

describe("кривой блок не ломает показ всего ответа (21.10.2026)", () => {
  const answer = JSON.stringify({
    schema_version: 1, ok: true,
    output: [
      { type: "heading", level: 2, text: "Заголовок" },
      { type: "text", text: "Абзац по делу" },
      { type: "widget", widget: { title: "без типа" } },
    ],
    artifacts: [], plan_artifact: null, error: null, next_hint: null, needs_human: false,
  });

  it("голый JSON: остальные блоки показываются, претензия сохранена", () => {
    const parsed = parseRoleContractV1(answer);
    expect(parsed.text).toContain("Абзац по делу");
    expect(parsed.text).not.toContain("schema_version");
    expect(parsed.structuredEnvelope?.output).toHaveLength(2);
    expect(parsed.errors.join(" ")).toMatch(/widget/);
  });

  it("в блоке кода — так же", () => {
    const parsed = parseRoleContractV1("```json\n" + answer + "\n```");
    expect(parsed.text).toContain("Заголовок");
    expect(parsed.text).not.toContain("schema_version");
  });

  it("финальный ответ: показ без сырого JSON, правка сервера видна в журнале", () => {
    const normalized = normalizeRoleReplyV1(answer);
    expect(normalized.displayText).not.toContain("schema_version");
    expect(normalized.normalizedByServer).toBe(true);
    expect(normalized.validationErrors.length).toBeGreaterThan(0);
  });

  it("строгая проверка формата по-прежнему отклоняет кривой ответ", () => {
    expect(validateStructuredRoleContractV1(JSON.parse(answer)).valid).toBe(false);
  });
});

// 24.10.2026: владелец показал, что ответ «пояснение + JSON» приходит сырым
// текстом. Разбор должен вырезать конверт из произвольного текста.
describe("конверт, вклиненный в текст", () => {
  const envelope = {
    schema_version: 1, ok: true,
    output: [{ type: "text", text: "Спиннер по центру." }],
    artifacts: [], plan_artifact: null, error: null, next_hint: null, needs_human: false,
  };

  it("JSON после пояснения распознаётся, обвязка сохраняется", () => {
    const raw = "Исправил, вот отчёт:\n" + JSON.stringify(envelope) + "\nГотово.";
    const parsed = parseRoleContractV1(raw);
    expect(parsed.structuredEnvelope).not.toBeNull();
    expect(parsed.text).toContain("Спиннер по центру.");
    expect(parsed.text).toContain("Исправил, вот отчёт:");
    expect(parsed.text).toContain("Готово.");
    expect(parsed.text).not.toContain("schema_version");
  });

  it("нормализация в чате не отдаёт сырой JSON", () => {
    const raw = "Пояснение\n" + JSON.stringify(envelope);
    const normalized = normalizeRoleReplyV1(raw);
    expect(normalized.displayText).not.toContain("schema_version");
    expect(normalized.displayText).toContain("Спиннер по центру.");
  });

  it("обычный текст без конверта остаётся текстом", () => {
    const parsed = parseRoleContractV1("Просто слова без JSON.");
    expect(parsed.structuredEnvelope).toBeNull();
  });
});

describe("конверт с лишними закрывающими скобками в конце", () => {
  // Владелец 27.10.2026: Помощница выдала верный конверт и приписала «}]}» —
  // ответ ушёл в чат сырым JSON. Хвост из одних скобок отбрасываем.
  const envelope = { schema_version: 1, ok: true, output: [
    { type: "heading", level: 2, text: "Composio: каталог" },
    { type: "text", text: "Полный каталог — 1681 сервис." },
  ] };
  it("лишние }]} после объекта — разбирается как конверт", () => {
    const parsed = parseRoleContractV1(JSON.stringify(envelope) + "}]}");
    expect(parsed.format).toBe("v1");
    expect(parsed.text).toContain("Composio: каталог");
    expect(parsed.text).toContain("Полный каталог — 1681 сервис.");
    expect(parsed.text).not.toContain("schema_version");
  });
  it("после объекта осмысленный текст — не отбрасывается", () => {
    const parsed = parseRoleContractV1(JSON.stringify(envelope) + " и ещё пояснение");
    expect(parsed.text).toContain("и ещё пояснение");
  });
});

describe("конверт с неизвестным полем верхнего уровня", () => {
  // Владелец 27.10.2026: Помощница добавила своё поле report — конверт
  // отвергался целиком, и в чат уходил сырой JSON.
  const envelope = { schema_version: 1, ok: true, output: [
    { type: "heading", level: 2, text: "Composio: каталог" },
    { type: "text", text: "Полный каталог — 1681 сервис." },
  ], artifacts: [], plan_artifact: null, error: null, next_hint: null, report: { materials: [] } };
  it("лишнее поле отбрасывается, ответ разворачивается блоками", () => {
    const normalized = normalizeRoleReplyV1(JSON.stringify(envelope) + "]}");
    expect(normalized.displayText).toContain("Composio: каталог");
    expect(normalized.displayText).not.toContain("schema_version");
    expect(normalized.envelope.output.map((b: any) => b.type)).toEqual(["heading", "text"]);
    expect((normalized.envelope as any).report).toBeUndefined();
  });
});
