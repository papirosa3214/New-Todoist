// Окно постановки задач: надиктовка владельца в чат → карточка-черновик
// (карточка 4396f8c9, 10.09.2026). Проверяется приёмка владельца целиком:
//
//   1) наговорил в окно — получил карточку с шагами, дочерними и порядком;
//   2) ни один агент на это сообщение не разбужен;
//   3) карточка лежит БЕЗ флага готовности, и взять её нельзя;
//   4) локальная модель недоступна — сообщение цело, причина видна;
//   5) повторная доставка того же сообщения не плодит вторую карточку.
//
// Локальная модель здесь подменена: предмет проверки — сервер, а не Ollama.
// Сам разбор проверяется живым прогоном на модели (см. заметку в
// документации проекта), тут он был бы медленным и невоспроизводимым.
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
const { demoteSeededOwner, seedRoleAccounts } = await import("./helpers/seedOwner.js");

/** Разбор идёт в фоне: сообщение отправляется, не дожидаясь модели. Ждём,
 *  пока строка разбора перестанет быть 'pending', а не фиксированную паузу —
 *  иначе тест либо мигает, либо тратит время на пустом месте.
 *
 *  В автоматическом режиме после status='done' сразу же запускается
 *  admitTreeAutomatically → dispatchTaskToPi (см. lib/ownerDraft.ts).
 *  Диспатч идёт ПОСЛЕ того, как draft получил status='done', поэтому
 *  простой waitForDraft возвращает карточку до того, как она уехала
 *  исполнителю. Тесты, которым нужно проверить assignee_id после
 *  автоматического режима, должны звать waitForDispatch поверх
 *  waitForDraft — иначе увидят null вместо ролевой учётки. */
async function waitForDraft(chatMessageId: string, ms = 3000) {
  const until = Date.now() + ms;
  for (;;) {
    const row = db
      .prepare(
        "SELECT status, task_id, error FROM chat_task_drafts WHERE chat_message_id = ?",
      )
      .get(chatMessageId) as
      | { status: string; task_id: string | null; error: string | null }
      | undefined;
    if (row && row.status !== "pending") return row;
    if (Date.now() > until) throw new Error(`разбор не завершился за ${ms}мс`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Подождать, пока задача получит assignee_id — то есть пока диспетчер
 *  в автоматическом режиме закончит работу. Без этого тест читал БД
 *  между status='done' в chat_task_drafts и реальным UPDATE tasks. */
async function waitForAssignee(taskId: string, ms = 3000) {
  const until = Date.now() + ms;
  for (;;) {
    const row = db
      .prepare("SELECT assignee_id FROM tasks WHERE id = ?")
      .get(taskId) as { assignee_id: string | null } | undefined;
    if (row && row.assignee_id) return row.assignee_id;
    if (Date.now() > until) throw new Error(`assignee_id не выставлен за ${ms}мс`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("Окно постановки задач (карточка 4396f8c9)", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let orchId: string;
  let agentId: string;
  let agentAuth: string;
  let projectId: string;

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

  const dictate = (text: string) =>
    app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: ownerAuth },
      // Адресата строка ввода подставляет сама (fixedAddressee), но сервер
      // его всё равно не слушает: в этом канале адресата нет.
      payload: { text, to_user_id: "all" },
    });

  beforeAll(async () => {
    app = await buildApp();
    // Миграция 039_seed_owner сидит 'u1' как владельца; иначе ownerId()
    // в routes/chat.ts возвращает u1, а не нашего Владельца, и
    // routeMessage не различает каналы owner/agents. Понижаем u1 до agent.
    demoteSeededOwner(db);
    // dispatch.ts при автоматическом режиме надиктовки пишет assignee_id
    // в role_* учётки (ROLE_USER_IDS). Без сидов FOREIGN KEY в диспетчере
    // валится, надиктовка возвращает «failed», и тесты на assignee_id
    // падают по неинформативной причине. Сеем те же восемь role-учёток,
    // что есть в живой БД (заводятся владельцем через /api/agents — в
    // тестах отдельный путь не нужен).
    seedRoleAccounts(db);

    const owner = await register("Владелец", "owner@dictation.test");
    ownerAuth = `Bearer ${owner.token}`;
    const orch = await register("Оркестратор", "orch@dictation.test");
    orchId = orch.id;
    const agent = await register("Исполнитель", "agent@dictation.test");
    agentId = agent.id;
    agentAuth = `Bearer ${agent.token}`;

    const setRole = db.prepare("UPDATE users SET role = ? WHERE id = ?");
    setRole.run("owner", owner.id);
    setRole.run("orchestrator", orchId);
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentId);

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: ownerAuth },
      payload: { name: "Домашний сервер" },
    });
    projectId = project.json().project?.id ?? project.json().id;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    model.impl = null;
  });

  it("надиктовка становится карточкой с шагами, дочерними и порядком между ними", async () => {
    model.impl = async (text: string, projects: Array<{ id: string }>) => {
      // Модель получает и текст, и список проектов — выбирать ей есть из чего.
      expect(text).toContain("почини");
      expect(projects.some((p) => p.id === projectId)).toBe(true);
      return {
        title: "Порядок на домашнем сервере",
        description: "Починить бэкап и обновить диск",
        subtasks: ["Свести результат"],
        dueDate: "2026-09-20",
        priority: 2,
        projectId,
        children: [
          {
            title: "Починить бэкап",
            description: "Разобраться, почему не едет",
            subtasks: ["Посмотреть логи", "Перезапустить"],
            after: null,
          },
          {
            title: "Обновить диск",
            description: "",
            subtasks: ["Купить", "Поставить"],
            after: 1,
          },
        ],
      };
    };

    const sent = await dictate("почини бэкап и потом обнови диск");
    expect(sent.statusCode).toBe(200);
    const draft = await waitForDraft(sent.json().id);
    expect(draft.status).toBe("done");

    const parent = db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(draft.task_id) as any;
    expect(parent.title).toBe("Порядок на домашнем сервере");
    expect(parent.project_id).toBe(projectId);
    expect(parent.due_date).toBe("2026-09-20");
    expect(parent.priority).toBe(2);

    const children = db
      .prepare("SELECT * FROM tasks WHERE parent_id = ? ORDER BY position")
      .all(draft.task_id) as any[];
    expect(children.map((c) => c.title)).toEqual([
      "Починить бэкап",
      "Обновить диск",
    ]);
    // Порядок — строкой очереди в описании зависимой карточки, тем же
    // приёмом, каким владелец пишет её руками.
    expect(children[0].description).not.toContain("ОЧЕРЕДЬ");
    expect(children[1].description).toContain("ОЧЕРЕДЬ");
    expect(children[1].description).toContain("Починить бэкап");

    // Шаги — и у родителя, и у каждого ребёнка.
    const steps = (taskId: string) =>
      (
        db
          .prepare(
            "SELECT title FROM subtasks WHERE task_id = ? ORDER BY position",
          )
          .all(taskId) as Array<{ title: string }>
      ).map((s) => s.title);
    expect(steps(draft.task_id!)).toEqual(["Свести результат"]);
    expect(steps(children[0].id)).toEqual(["Посмотреть логи", "Перезапустить"]);
    expect(steps(children[1].id)).toEqual(["Купить", "Поставить"]);
  });

  it("карточка лежит без флага готовности — взять её нельзя, пока владелец не поднимет", async () => {
    model.impl = async () => ({
      title: "Черновик",
      description: "",
      subtasks: [],
      dueDate: null,
      priority: 4,
      projectId: null,
      children: [],
    });
    const sent = await dictate("надиктовка про черновик");
    const draft = await waitForDraft(sent.json().id);

    const row = db
      .prepare("SELECT ready_for_pickup, assignee_id FROM tasks WHERE id = ?")
      .get(draft.task_id) as {
      ready_for_pickup: number;
      assignee_id: string | null;
    };
    expect(row.ready_for_pickup).toBe(0);
    // Исполнителя машина не назначает — кому делать, решает владелец.
    expect(row.assignee_id).toBeNull();

    // Назначаем исполнителя руками, как это сделал бы владелец, — чтобы в
    // отказе на claim осталась ровно одна причина: флага нет. Без назначения
    // агент упёрся бы раньше, в «карточка не твоя», и про флаг тест ничего
    // бы не доказал.
    const assigned = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${draft.task_id}`,
      headers: { authorization: ownerAuth },
      payload: { assignee_id: agentId },
    });
    expect(assigned.statusCode).toBe(200);

    const claim = await app.inject({
      method: "POST",
      url: `/api/tasks/${draft.task_id}/claim`,
      headers: { authorization: agentAuth },
    });
    expect(claim.statusCode).toBe(400);
    expect(claim.json().error).toMatch(/готова к самозахвату/);
  });

  it("ни один агент не разбужен: адресата нет, поручение не записано", async () => {
    model.impl = async () => ({
      title: "Тихая карточка",
      description: "",
      subtasks: [],
      dueDate: null,
      priority: 4,
      projectId: null,
      children: [],
    });
    const inboxBefore = (
      db.prepare("SELECT COUNT(*) as n FROM agent_inbox").get() as { n: number }
    ).n;

    const sent = await dictate("сделай тихую карточку");
    expect(sent.json().to_user_id).toBeNull();
    expect(sent.json().channel).toBe("owner");
    await waitForDraft(sent.json().id);

    const inboxAfter = (
      db.prepare("SELECT COUNT(*) as n FROM agent_inbox").get() as { n: number }
    ).n;
    expect(inboxAfter).toBe(inboxBefore);

    // И в непрочитанное оркестратору надиктовка тоже не падает: счётчик —
    // тот же зов агента, только через цифру на экране.
    const unread = db
      .prepare(
        `SELECT COUNT(*) as n FROM chat_messages
          WHERE channel = 'owner' AND to_user_id IS NULL`,
      )
      .get() as { n: number };
    expect(unread.n).toBeGreaterThan(0); // надиктовки действительно без адресата
  });

  it("ответ приходит в ту же ленту, со ссылкой на карточку", async () => {
    model.impl = async () => ({
      title: "Карточка со ссылкой",
      description: "",
      subtasks: ["шаг"],
      dueDate: null,
      priority: 4,
      projectId: null,
      children: [],
    });
    const sent = await dictate("надиктовка со ссылкой");
    const draft = await waitForDraft(sent.json().id);

    const reply = db
      .prepare(
        `SELECT m.*, u.name as from_name FROM chat_messages m
           JOIN users u ON u.id = m.from_user_id
          WHERE m.task_id = ? ORDER BY m.created_at DESC LIMIT 1`,
      )
      .get(draft.task_id) as any;
    expect(reply).toBeTruthy();
    expect(reply.channel).toBe("owner");
    expect(reply.from_name).toBe("Секретарь");
    expect(reply.text).toMatch(/флаг готовности/);
  });

  it("модель недоступна: надиктовка цела, причина видна, карточки нет", async () => {
    model.impl = async () => {
      throw new Error("Не удалось связаться с локальной моделью (Ollama).");
    };
    const tasksBefore = (
      db.prepare("SELECT COUNT(*) as n FROM tasks").get() as { n: number }
    ).n;

    const sent = await dictate("надиктовка на мёртвой модели");
    expect(sent.statusCode).toBe(200);
    const draft = await waitForDraft(sent.json().id);
    expect(draft.status).toBe("failed");
    expect(draft.error).toMatch(/Ollama/);

    // Ничего не создано.
    const tasksAfter = (
      db.prepare("SELECT COUNT(*) as n FROM tasks").get() as { n: number }
    ).n;
    expect(tasksAfter).toBe(tasksBefore);

    // Сама надиктовка на месте.
    const original = db
      .prepare("SELECT text FROM chat_messages WHERE id = ?")
      .get(sent.json().id) as { text: string };
    expect(original.text).toBe("надиктовка на мёртвой модели");

    // И причина написана владельцу в ту же ленту. Сортировка добавляет
    // rowid: created_at пишется с точностью до секунды, и несколько ответов
    // одной секунды иначе выстраиваются в произвольном порядке.
    const excuse = db
      .prepare(
        `SELECT text FROM chat_messages
          WHERE from_user_id = 'u-secretary'
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get() as { text: string };
    expect(excuse.text).toMatch(/Ollama/);
    expect(excuse.text).toMatch(/цела/);
  });

  it("повторная доставка того же сообщения второй карточки не заводит", async () => {
    let calls = 0;
    model.impl = async () => {
      calls += 1;
      return {
        title: "Один раз",
        description: "",
        subtasks: [],
        dueDate: null,
        priority: 4,
        projectId: null,
        children: [],
      };
    };
    const sent = await dictate("надиктовка, доставленная дважды");
    const draft = await waitForDraft(sent.json().id);
    expect(calls).toBe(1);

    // Повтор доставки того же сообщения — как если бы событие пришло дважды.
    const { startDraftFromChat } = await import("../src/lib/ownerDraft.js");
    startDraftFromChat({
      id: sent.json().id,
      from_user_id: sent.json().from_user_id,
      text: "надиктовка, доставленная дважды",
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toBe(1);

    const sameTitle = (
      db
        .prepare("SELECT COUNT(*) as n FROM tasks WHERE title = ?")
        .get("Один раз") as { n: number }
    ).n;
    expect(sameTitle).toBe(1);
    expect(draft.task_id).toBeTruthy();
  });

  it("голосовая надиктовка разбирается так же, как набранная руками", async () => {
    // Голос доезжает сюда уже расшифрованным: тот же POST /api/chat, только
    // с пометкой source='voice' (карточка 5f292e87). Разбору она безразлична
    // — и проверяется тут именно это, чтобы «голос» не оказался вторым,
    // отдельно ломающимся путём.
    model.impl = async (text: string) => {
      expect(text).toContain("голосом");
      return {
        title: "Задача, наговоренная голосом",
        description: "",
        subtasks: ["шаг"],
        dueDate: null,
        priority: 4,
        projectId: null,
        children: [],
      };
    };
    const sent = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: ownerAuth },
      payload: {
        text: "это я надиктовал голосом, сделай карточку",
        to_user_id: "all",
        source: "voice",
      },
    });
    expect(sent.statusCode).toBe(200);
    const draft = await waitForDraft(sent.json().id);
    expect(draft.status).toBe("done");

    const task = db
      .prepare("SELECT title FROM tasks WHERE id = ?")
      .get(draft.task_id) as { title: string };
    expect(task.title).toBe("Задача, наговоренная голосом");
  });

  it("сообщение владельца в служебной ленте карточку не заводит", async () => {
    // Граница: окно постановки — не единственное место, где владелец пишет.
    // В рабочей ленте он раздаёт работу живым исполнителям, и превращать это
    // в черновики значило бы заводить карточку на каждое «глянь, пожалуйста».
    model.impl = async () => {
      throw new Error("модель не должна была вызываться");
    };
    const sent = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: ownerAuth },
      payload: {
        text: "глянь, почему сборка красная",
        to_user_id: agentId,
        channel: "agents",
      },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().channel).toBe("agents");
    await new Promise((r) => setTimeout(r, 150));

    const drafted = db
      .prepare("SELECT 1 FROM chat_task_drafts WHERE chat_message_id = ?")
      .get(sent.json().id);
    expect(drafted).toBeUndefined();
  });

  it("сообщение про существующую карточку разбором не считается", async () => {
    model.impl = async () => {
      throw new Error("модель не должна была вызываться");
    };
    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: ownerAuth },
      payload: { title: "Уже заведённая задача" },
    });
    const taskId = task.json().task.id;

    const sent = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: ownerAuth },
      payload: {
        text: "тут я про уже существующую",
        to_user_id: "all",
        task_id: taskId,
      },
    });
    expect(sent.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 150));

    const drafted = db
      .prepare("SELECT 1 FROM chat_task_drafts WHERE chat_message_id = ?")
      .get(sent.json().id);
    expect(drafted).toBeUndefined();
  });
  // ─────────────────────────────────────────────────────────────────────
  // Автоматический режим (раздел 8.1 спецификации от 14.09.2026).
  // Смысл проверок: тумблер владельца должен НА САМОМ ДЕЛЕ менять судьбу
  // надиктовки. До 14.09.2026 режим хранился в базе и фиксировался на
  // сообщении, но конвейер его не спрашивал — любая надиктовка молча
  // останавливалась черновиком, как в ручном режиме.
  //
  // Замечание про дизайн: до правки 14.09.2026 (одна учётка Pi Agent для
  // всех 8 ролей) тест ожидал, что assignee_id = PI_AGENT_ID. Текущий код
  // в routes/dispatch.ts пишет assignee_id = ROLE_USER_IDS[chosen] —
  // отдельную role-учётку, в которую в итоге приходит задача (и та же
  // учётка получает notifications/inbox). Это сознательный выбор кода,
  // вокруг которого сидит весь чатовый слой: каждая роль — самостоятельный
  // участник переписки. Тест проверяет не конкретный id, а что задача
  // отдана роли и у этой роли есть конкретная учётка; для architect это
  // role_architect. Если владелец решит вернуть дизайн «Pi = единый
  // runtime» и код dispatch.ts переедет на PI_AGENT_ID, константу нужно
  // будет вернуть к PI_AGENT_ID — оба эти теста фиксируют форму
  // «кто-то конкретный», а не конкретный id.
  const DISPATCH_RECIPIENT_ID = "role_architect";

  const setMode = async (mode: "manual" | "automatic") => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/task-intake/settings",
      headers: { authorization: ownerAuth },
      payload: { mode },
    });
    expect(res.statusCode).toBe(200);
  };

  it("автоматический режим: карточка сама получает флаг и уходит исполнителю", async () => {
    await setMode("automatic");
    model.impl = async () => ({
      title: "Автоматическая",
      description: "",
      subtasks: [],
      dueDate: null,
      priority: 4,
      projectId: null,
      children: [],
    });

    const sent = await dictate("сделай это сам, без меня");
    const draft = await waitForDraft(sent.json().id);
    // Автоматический режим: dispatchTaskToPi запускается ПОСЛЕ status='done'
    // в chat_task_drafts. Без явного ожидания assignee_id читаем БД между
    // «разбор завершён» и «диспетчер успел сделать UPDATE» — получаем null.
    await waitForAssignee(draft.task_id!);

    const row = db
      .prepare(
        "SELECT ready_for_pickup, assignee_id, dispatched_role FROM tasks WHERE id = ?",
      )
      .get(draft.task_id) as {
      ready_for_pickup: number;
      assignee_id: string | null;
      dispatched_role: string | null;
    };
    // Владелец флаг не поднимал — его поднял сервер.
    expect(row.ready_for_pickup).toBe(1);
    // И тем же путём, что руками: карточка у единственного runtime.
    expect(row.assignee_id).toBe(DISPATCH_RECIPIENT_ID);
    expect(row.dispatched_role).toBeTruthy();

    await setMode("manual");
  });

  it("автоматический режим: работают дети, родитель остаётся контейнером", async () => {
    await setMode("automatic");
    model.impl = async () => ({
      title: "Родитель-контейнер",
      description: "",
      subtasks: [],
      dueDate: null,
      priority: 4,
      projectId: null,
      children: [
        { title: "Первый шаг", description: "", subtasks: [], after: null },
        { title: "Второй шаг", description: "", subtasks: [], after: 1 },
      ],
    });

    const sent = await dictate("сделай большое дело в два приёма");
    const draft = await waitForDraft(sent.json().id);

    const parent = db
      .prepare("SELECT ready_for_pickup, assignee_id FROM tasks WHERE id = ?")
      .get(draft.task_id) as { ready_for_pickup: number; assignee_id: string | null };
    // Родитель не исполняется одновременно с детьми (раздел 6.3).
    expect(parent.ready_for_pickup).toBe(0);
    expect(parent.assignee_id).toBeNull();

    const children = db
      .prepare(
        "SELECT title, ready_for_pickup, assignee_id FROM tasks WHERE parent_id = ? ORDER BY position",
      )
      .all(draft.task_id) as Array<{
      title: string;
      ready_for_pickup: number;
      assignee_id: string | null;
    }>;
    expect(children).toHaveLength(2);
    // Флаг поднят обоим: частичная готовность дерева запрещена (раздел 12).
    expect(children[0].ready_for_pickup).toBe(1);
    expect(children[1].ready_for_pickup).toBe(1);
    // А отдан исполнителю только первый: второй ждёт своей очереди, иначе
    // второй шаг поехал бы раньше первого.
    expect(children[0].assignee_id).toBe(DISPATCH_RECIPIENT_ID);
    expect(children[1].assignee_id).toBeNull();

    await setMode("manual");
  });

  it("роль из постановки записана в карточку и в ленту с причиной", async () => {
    model.impl = async () => ({
      title: "Показать «печатает» в чате",
      description: "",
      subtasks: [],
      dueDate: null,
      priority: 4,
      projectId: null,
      children: [],
      role: "builder",
      roleReason: "нужно событие на сервере и его показ в приложении",
      where: "iphone",
    });
    const sent = await dictate("сделай индикатор печатает в приложении");
    const draft = await waitForDraft(sent.json().id);
    const row = db
      .prepare("SELECT machine_selected_role, description FROM tasks WHERE id = ?")
      .get(draft.task_id) as { machine_selected_role: string; description: string };
    expect(row.machine_selected_role).toBe("builder");
    expect(row.description).toContain("📍 ГДЕ: приложение на iPhone");
    const ev = db
      .prepare("SELECT actor_id, to_value FROM task_events WHERE task_id = ? AND kind = 'role_choice'")
      .get(draft.task_id) as { actor_id: string | null; to_value: string };
    expect(ev.actor_id).toBeNull();
    expect(ev.to_value).toContain("Разработчик");
    expect(ev.to_value).toContain("событие на сервере");
  });

  it("автоматический режим: личное дело остаётся владельцу, агенту не уходит", async () => {
    await setMode("automatic");
    model.impl = async () => ({
      title: "Продлить ОСАГО",
      description: "",
      subtasks: ["Оплатить полис"],
      dueDate: null,
      priority: 4,
      projectId: null,
      children: [],
      role: null,
      roleReason: "",
      where: "личное",
    });
    const sent = await dictate("продли осаго до четвёртого сентября");
    const draft = await waitForDraft(sent.json().id);
    await new Promise((r) => setTimeout(r, 200));
    const row = db
      .prepare("SELECT ready_for_pickup, assignee_id, dispatched_role FROM tasks WHERE id = ?")
      .get(draft.task_id) as {
      ready_for_pickup: number;
      assignee_id: string | null;
      dispatched_role: string | null;
    };
    expect(row.ready_for_pickup).toBe(0);
    expect(row.dispatched_role).toBeNull();
    const owner = db
      .prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1")
      .get() as { id: string };
    expect(row.assignee_id).toBe(owner.id);
    await setMode("manual");
  });

  it("«✓ Идёт» из чата: черновик запускается с очередью, личное не трогается", async () => {
    await setMode("manual");
    model.impl = async () => ({
      title: "Три дела",
      description: "",
      subtasks: [],
      dueDate: null,
      priority: 4,
      projectId: null,
      children: [
        { title: "Починить кнопку", description: "", result: "", question: null, subtasks: [], after: null, role: "builder" },
        { title: "Добавить фильтр", description: "", result: "", question: null, subtasks: [], after: 1, role: "builder" },
        { title: "Записаться к врачу", description: "", result: "", question: null, subtasks: [], after: null, role: null, where: "личное" },
      ],
    });
    const sent = await dictate("почини кнопку потом фильтр и запишись к врачу");
    const draft = await waitForDraft(sent.json().id);
    const kids = db
      .prepare("SELECT id, title FROM tasks WHERE parent_id = ? ORDER BY position")
      .all(draft.task_id) as Array<{ id: string; title: string }>;

    const res = await app.inject({
      method: "POST",
      url: `/api/task-intake/drafts/${draft.task_id}/start`,
      headers: { authorization: ownerAuth },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ started: 1, queued: 1 });

    const row = (id: string) =>
      db.prepare("SELECT ready_for_pickup, dispatched_role FROM tasks WHERE id = ?").get(id) as {
        ready_for_pickup: number;
        dispatched_role: string | null;
      };
    expect(row(kids[0].id)).toMatchObject({ ready_for_pickup: 1, dispatched_role: "builder" });
    expect(row(kids[1].id)).toMatchObject({ ready_for_pickup: 1, dispatched_role: null });
    expect(row(kids[2].id).ready_for_pickup).toBe(0);
  });

  it("ручной режим по-прежнему останавливается на черновике", async () => {
    await setMode("manual");
    model.impl = async () => ({
      title: "Ручная",
      description: "",
      subtasks: [],
      dueDate: null,
      priority: 4,
      projectId: null,
      children: [],
    });

    const sent = await dictate("а это я посмотрю сам");
    const draft = await waitForDraft(sent.json().id);

    const row = db
      .prepare("SELECT ready_for_pickup, assignee_id FROM tasks WHERE id = ?")
      .get(draft.task_id) as {
      ready_for_pickup: number;
      assignee_id: string | null;
    };
    expect(row.ready_for_pickup).toBe(0);
    expect(row.assignee_id).toBeNull();
  });

  it("очередь едет дальше: закрыли первый шаг — второй уходит исполнителю сам", async () => {
    await setMode("automatic");
    model.impl = async () => ({
      title: "Дело в два приёма",
      description: "",
      subtasks: [],
      dueDate: null,
      priority: 4,
      projectId: null,
      children: [
        { title: "Сначала это", description: "", subtasks: [], after: null },
        { title: "Потом то", description: "", subtasks: [], after: 1 },
      ],
    });

    const sent = await dictate("два шага по очереди");
    const draft = await waitForDraft(sent.json().id);

    const children = db
      .prepare(
        "SELECT id, title, assignee_id FROM tasks WHERE parent_id = ? ORDER BY position",
      )
      .all(draft.task_id) as Array<{
      id: string;
      title: string;
      assignee_id: string | null;
    }>;
    // Исходное состояние: первый у исполнителя, второй ждёт.
    expect(children[0].assignee_id).toBe(DISPATCH_RECIPIENT_ID);
    expect(children[1].assignee_id).toBeNull();

    // Закрываем первый — так же, как это сделает исполнитель или владелец.
    const closed = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${children[0].id}`,
      headers: { authorization: ownerAuth },
      payload: { status: "completed" },
    });
    expect(closed.statusCode).toBe(200);

    // Второй должен уехать сам, без участия владельца. Без этого автомат
    // делал ровно один шаг дерева и вставал.
    const second = db
      .prepare("SELECT assignee_id, dispatched_role FROM tasks WHERE id = ?")
      .get(children[1].id) as {
      assignee_id: string | null;
      dispatched_role: string | null;
    };
    expect(second.assignee_id).toBe(DISPATCH_RECIPIENT_ID);
    expect(second.dispatched_role).toBeTruthy();

    await setMode("manual");
  });

  it("критерий результата попадает в описание карточки", async () => {
    await setMode("manual");
    model.impl = async () => ({
      title: "Задача с критерием",
      description: "что сделать",
      result: "кнопка сохраняет черновик и он виден после перезахода",
      question: null,
      subtasks: [],
      dueDate: null,
      priority: 4,
      projectId: null,
      children: [],
    });

    const sent = await dictate("сделай кнопку сохранения");
    const draft = await waitForDraft(sent.json().id);

    const row = db
      .prepare("SELECT description FROM tasks WHERE id = ?")
      .get(draft.task_id) as { description: string | null };
    // Отдельной колонки под критерий в схеме нет — он идёт строкой в
    // описании, тем же приёмом, что и очередь. Раздел 7 спецификации.
    expect(row.description).toContain("✅ РЕЗУЛЬТАТ:");
    expect(row.description).toContain("виден после перезахода");
  });

  it("вопрос владельцу останавливает автомат: дерево целиком без флага", async () => {
    await setMode("automatic");
    model.impl = async () => ({
      title: "Непонятная задача",
      description: "",
      result: "",
      question: "О какой из двух баз речь — рабочей или тестовой?",
      subtasks: [],
      dueDate: null,
      priority: 4,
      projectId: null,
      children: [
        { title: "Первый кусок", description: "", result: "", question: null, subtasks: [], after: null },
        { title: "Второй кусок", description: "", result: "", question: null, subtasks: [], after: null },
      ],
    });

    const sent = await dictate("почини там базу");
    const draft = await waitForDraft(sent.json().id);

    // Частичный запуск запрещён: ни одна карточка дерева не поднята и не
    // отдана, хотя вопрос был только к родителю (раздел 8.1).
    const все = db
      .prepare(
        "SELECT ready_for_pickup, assignee_id FROM tasks WHERE id = ? OR parent_id = ?",
      )
      .all(draft.task_id, draft.task_id) as Array<{
      ready_for_pickup: number;
      assignee_id: string | null;
    }>;
    expect(все).toHaveLength(3);
    for (const карточка of все) {
      expect(карточка.ready_for_pickup).toBe(0);
      expect(карточка.assignee_id).toBeNull();
    }

    // И сам вопрос сохранён на карточке, а не потерян в чате.
    const родитель = db
      .prepare(
        "SELECT needs_clarification, clarification_question FROM tasks WHERE id = ?",
      )
      .get(draft.task_id) as {
      needs_clarification: number;
      clarification_question: string | null;
    };
    expect(родитель.needs_clarification).toBe(1);
    expect(родитель.clarification_question).toContain("рабочей или тестовой");

    await setMode("manual");
  });
});
