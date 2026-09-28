// Карточка ae5d695b — «Протестировать работу агентов с объемными запросами».
// Цель: при большом входе у задачи появляется файл-приложение с ИСХОДНЫМ
// текстом, а в её полях (title, description) полного текста нет. Так снимается
// жалоба владельца от 20.09.2026: «почему большой текст уходит в чат, а в
// карточке только крошки» — контур именно для этого и сделан, через
// `attachSourceText` в lib/ownerDraft.ts.
//
// Что НЕ проверяем здесь (и почему):
//   - Реальный разбор локальной моделью: его достоверность проверяется
//     живым прогоном на модели (см. заметку в документации проекта), а не
//     vitest. Здесь модель замокана, как в ownerDictation.test.ts.
//   - Диспатч/assignee_id: по сценарию карточки остаётся черновиком без
//     флага готовности (миграция 026), исполнителя нет.
//
// Замокан только разбор (`structureDictationToCards`). `attachSourceText`
// отрабатывает НАСТОЯЩИМ `saveUploadedFile` — мы и хотим проверить, что
// файл уходит на диск и попадает в `attachments` с правильным kind/mime.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const model = vi.hoisted(() => ({
  impl: null as null | ((...args: any[]) => Promise<any>),
}));

vi.mock("../src/routes/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/routes/ai.js")>();
  return {
    ...actual,
    structureDictationToCards: (...args: any[]) => {
      if (!model.impl) throw new Error("тест не задал ответ модели");
      return model.impl(...args);
    },
  };
});

const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");
const { demoteSeededOwner } = await import("./helpers/seedOwner.js");
const { createDraftFromText } = await import("../src/lib/ownerDraft.js");
const { UPLOAD_DIR } = await import("../src/routes/attachments.js");

// Три варианта «большого входа» — каждый по своей форме:
//   1) диалог (переписка двух людей), реалистичный вид;
//   2) поэтапный план с маркедауном;
//   3) «поток сознания» без структуры — самый тяжёлый случай для парсера,
//      на нём проверяем, что файл всё равно пишется (мягкая деградация).
const SCENARIOS: Array<{ name: string; body: string; expectedTitle: string }> =
  [
    {
      name: "диалог",
      body: [
        "Максим: Слушай, у нас в пятницу релиз, надо чтобы платежи прошли без сюрпризов.",
        "Команда: Проверили вебхуки — там два сценария, в одном из них мы теряем id заказа.",
        "Максим: Какой сценарий и в каком месте?",
        "Команда: Это когда клиент жмёт «Оплатить», страница редиректит, а у нас уже истёк TTL сессии. Мы пересоздаём заказ и старый теряем.",
        "Максим: Понял. Сделайте так, чтобы старый заказ поднимался заново из идемпотентного ключа, а не пропадал.",
        "Команда: Сделаем. Но есть ещё проблема — у нас нет живого провайдера для тестов, можно сделать мок и параллельно прогон на паре боевых ключей?",
        "Максим: Да. И заведите отдельный проект «Стабильность платежей», чтобы не смешивать с фичей возвратов.",
        "Команда: Принято. По срокам — до среды управимся с вебхуком, тесты — к четвергу, релиз — в пятницу как планировали.",
        "Максим: Договорились. Главное — чтобы ничего не уехало к клиентам без подтверждения.",
        "Команда: Понимаем. Сделаем.",
      ].join("\n"),
      expectedTitle: "Стабильность платежей к пятничному релизу",
    },
    {
      name: "план",
      body: [
        "# План перевода инфраструктуры на новые мощности",
        "",
        "## Фаза 1 — подготовка",
        "- [ ] Согласовать окно отключения с владельцем",
        "- [ ] Поднять второй кластер рядом с боевым, без записи в прод-DNS",
        "- [ ] Прогнать нагрузочные тесты против нового кластера",
        "",
        "## Фаза 2 — миграция",
        "- [ ] Перелить базы на новые ноды без остановки записи (logical replication)",
        "- [ ] Порезать нагрузку: 10% трафика → 30% → 60% → 100%",
        "",
        "## Фаза 3 — зачистка",
        "- [ ] Снять старые ноды из DNS",
        "- [ ] Обнулить старые тома",
        "- [ ] Обновить документацию по аварийному восстановлению",
        "",
        "Критерий готовности: 95-й перцентиль по задержкам не хуже текущего, откат возможен за 15 минут.",
      ].join("\n"),
      expectedTitle: "Перевод инфраструктуры на новые мощности",
    },
    {
      name: "поток",
      body: [
        "Ну вот смотри, есть у нас в чатовом слое штука, которая сейчас работает на одном рантайме, она держит историю сообщений и отдаёт её на UI, и вроде бы всё нормально, но мы её уже два раза дописывали, и теперь там пять классов в одном файле, и разобраться где что — никто не может.",
        "Я хочу её разнести по слоям: модели отдельно, транспорт отдельно, рендер отдельно, чтобы каждый шаг можно было покрыть тестом и чтобы новый человек мог зайти и понять, что здесь вообще происходит.",
        "При этом поведение наружу не должно поменяться: те же поля в API, та же скорость, та же устойчивость к сетевым обрывам. То есть это чисто внутренняя перетряска, без PR наружу.",
        "По срокам — мне важно, чтобы к концу недели был каркас: новая модель данных, новый транспорт, и старая реализация просто отключается фичефлагом, не удаляется. Удалим её через месяц, когда убедимся, что новая дорога не хуже старой ни в одном сценарии, который мы сейчас наблюдаем.",
        "В качестве задела — давай сначала посмотрим, какие тесты уже есть на этот слой, и зафиксируем список того, что НЕ должно сломаться: рестарт при отвале ws, восстановление порядка сообщений после дублей, отдача истории при пустой комнате. Если эти сценарии на новой реализации ведут себя так же — можно катить.",
        "Если что-то из этого непонятно как покрывать — это тоже часть работы, обсудим. Главное — выйти из положения, когда есть пять классов и ни одного теста.",
      ].join("\n"),
      expectedTitle: "Разнести чатовый слой по слоям без изменения API",
    },
  ];

describe("Объёмный запрос → файл-приложение (карточка ae5d695b)", () => {
  let app: FastifyInstance;
  let owner: string;
  let ownerAuth: string;

  const register = async (name: string, email: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email, password: "password123" },
    });
    return {
      token: res.json().token as string,
      id: res.json().user.id as string,
    };
  };

  beforeAll(async () => {
    app = await buildApp();
    // Тот же приём, что и в ownerDictation.test.ts: иначе «самый ранний
    // владелец» — это u1, а не наш тестовый пользователь, и вызовы
    // createDraftFromText увидят не того.
    demoteSeededOwner(db);
    const me = await register("Владелец", "owner@volume.test");
    owner = me.id;
    ownerAuth = `Bearer ${me.token}`;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(owner);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    model.impl = null;
  });

  for (const scenario of SCENARIOS) {
    it(`[${scenario.name}] длинный текст ложится в .md, в полях задачи его нет`, async () => {
      const text = scenario.body;
      // Структуру не проверяем — её проверяет модель. Ответ нужен только
      // чтобы createDraftFromText прошёл до конца: дети, описание, всё
      // остальное для этой карточки неинтересно.
      model.impl = async () => ({
        title: scenario.expectedTitle,
        description: "",
        result: "",
        question: null,
        subtasks: [],
        dueDate: null,
        priority: 4,
        projectId: null,
        children: [],
      });

      const { parentId } = await createDraftFromText(text, owner);

      // 1) Задача создана и называется коротко.
      const task = db
        .prepare("SELECT id, title, description FROM tasks WHERE id = ?")
        .get(parentId) as { id: string; title: string; description: string };
      expect(task.title).toBe(scenario.expectedTitle);
      expect(task.title.length).toBeLessThanOrEqual(80);

      // 2) Полного текста в полях задачи нет. Это и есть главное: раньше
      // большой вход уезжал в чат целиком, а в карточке оставалась только
      // огрызок-описание; теперь контракт — файл лежит отдельно.
      expect(task.description ?? "").not.toContain(text);
      // На всякий случай — кусок в 100 символов из середины тоже не должен
      // всплыть в description / title.
      const middle = text.slice(Math.floor(text.length / 2), Math.floor(text.length / 2) + 100);
      expect(task.description ?? "").not.toContain(middle);
      expect(task.title).not.toContain(middle);

      // 3) К карточке прикреплён один файл kind='task' с правильным mime
      //    и сохранённым содержимым. Это и есть результат attachSourceText.
      const atts = db
        .prepare(
          `SELECT id, file_name, mime, size, kind, comment_id, stored_name
             FROM attachments
            WHERE task_id = ? AND kind = 'task'
            ORDER BY created_at DESC`,
        )
        .all(parentId) as Array<{
        id: string;
        file_name: string;
        mime: string;
        size: number;
        kind: string;
        comment_id: string | null;
        stored_name: string;
      }>;
      expect(atts).toHaveLength(1);
      const att = atts[0];
      expect(att.comment_id).toBeNull();
      expect(att.mime).toBe("text/markdown");
      expect(att.size).toBe(Buffer.byteLength(text, "utf8"));
      // Имя файла в БД укорочено до 80 символов + ".md" — это и есть
      // сигнал «исходник приложен», а не технический id.
      expect(att.file_name.endsWith(".md")).toBe(true);

      // 4) Сам файл лежит на диске, и его содержимое совпадает с исходником.
      const onDisk = fs.readFileSync(path.join(UPLOAD_DIR, att.stored_name));
      expect(onDisk.toString("utf8")).toBe(text);

      // 5) Теперь по контракту «большой текст НЕ в чате». В нашем сценарии
      //    createDraftFromText в чат вообще ничего не пишет — это серверный
      //    контур, не голос и не надиктовка; но проверим, что и в
      //    chat_messages от этого parent_id ничего лишнего не появилось.
      const chatTail = db
        .prepare(
          `SELECT COUNT(*) as n FROM chat_messages WHERE task_id = ? AND text LIKE ?`,
        )
        .get(parentId, `%${middle}%`) as { n: number };
      expect(chatTail.n).toBe(0);
    });
  }

  it("тот же контур через HTTP-маршрут /api/ai/structure-draft: файл есть, чат чист", async () => {
    // Маршрут, которым ходят «агенты» в живой системе — а не прямой вызов
    // функции. Подменяем модель, чтобы разбор прошёл без Ollama.
    const text = SCENARIOS[0].body; // диалог
    model.impl = async () => ({
      title: SCENARIOS[0].expectedTitle,
      description: "",
      result: "",
      question: null,
      subtasks: [],
      dueDate: null,
      priority: 4,
      projectId: null,
      children: [],
    });

    const snapBefore = db
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(text)), 0) AS chars
           FROM chat_messages`,
      )
      .get() as { chars: number };

    const res = await app.inject({
      method: "POST",
      url: "/api/ai/structure-draft",
      headers: { authorization: ownerAuth },
      payload: { text },
    });
    expect(res.statusCode).toBe(200);
    const { task_id: parentId } = res.json();

    // Файл приложен.
    const atts = db
      .prepare(
        `SELECT size FROM attachments
          WHERE task_id = ? AND kind = 'task'`,
      )
      .all(parentId) as Array<{ size: number }>;
    expect(atts).toHaveLength(1);
    expect(atts[0].size).toBe(Buffer.byteLength(text, "utf8"));

    // В описании задачи полного текста нет.
    const task = db
      .prepare("SELECT title, description FROM tasks WHERE id = ?")
      .get(parentId) as { title: string; description: string };
    expect(task.description ?? "").not.toContain(text);

    // Суммарный объём chat_messages по всей БД не вырос на величину
    // исходника: маршрут не должен был положить длинный текст в ленту.
    // (В живой системе ответ по карточке едет, но коротким сообщением от
    // Секретаря — не самим исходником.)
    const snapAfter = db
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(text)), 0) AS chars
           FROM chat_messages`,
      )
      .get() as { chars: number };
    expect(snapAfter.chars - snapBefore.chars).toBeLessThan(text.length);
  });

  it("короткий вход всё равно идёт файлом — расщепления «короткий в чат, длинный в файл» нет", async () => {
    // Граница: раньше можно было бояться «короткий текст уйдёт прямо в чат,
    // а большой — файлом». Этого расщепления быть не должно:
    // attachSourceText вызывается безусловно (lib/ownerDraft.ts:387), и
    // эта проверка фиксирует, что короткий вход тоже получает файл, а
    // полного текста в description — нет.
    const text =
      "Сделай быстро: перенеси встречу с четверга на пятницу, в то же время.";
    model.impl = async () => ({
      title: "Перенести встречу",
      description: "",
      result: "",
      question: null,
      subtasks: [],
      dueDate: null,
      priority: 4,
      projectId: null,
      children: [],
    });

    const { parentId } = await createDraftFromText(text, owner);

    const task = db
      .prepare("SELECT title, description FROM tasks WHERE id = ?")
      .get(parentId) as { title: string; description: string };
    expect(task.title).toBe("Перенести встречу");
    // Описание у этой карточки тоже без полного исходника.
    expect(task.description ?? "").not.toBe(text);

    const atts = db
      .prepare(
        `SELECT file_name, size FROM attachments
          WHERE task_id = ? AND kind = 'task'`,
      )
      .all(parentId) as Array<{ file_name: string; size: number }>;
    expect(atts).toHaveLength(1);
    expect(atts[0].file_name.endsWith(".md")).toBe(true);
    expect(atts[0].size).toBe(Buffer.byteLength(text, "utf8"));
  });
});
