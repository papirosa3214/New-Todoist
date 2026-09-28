import { enqueueRoleRunJob } from "../runtime/roleRunQueue.js";
// Окно постановки задач: надиктовка владельца в чат → карточка-черновик.
// Карточка 4396f8c9, 10.09.2026.
//
// ЗАМЫСЕЛ ВЛАДЕЛЬЦА, его словами: «я в чат просто наговорил — у меня сразу
// подключилась локальная модель, тут же разобрала всё, и в чате появляется
// карточка задачи, я открываю, читаю, и остаётся только флаг готовности
// поставить». Расписывает МАШИНА, целиком: название, описание, шаги, срок,
// приоритет, проект и разбиение на карточки — «самому сидеть и расписывать
// это всё мне вообще не хочется».
//
// ЧЕГО ЗДЕСЬ НЕТ И НЕ ДОЛЖНО БЫТЬ. Думающего посредника: решением 08.09.2026
// автономного оркестратора нет, и надиктовка не будит ни одного агента —
// работает этот скрипт и локальная модель. Карточка при этом появляется БЕЗ
// флага готовности (миграция 026): модель разберёт криво — не тот проект,
// лишние шаги, — и до тех пор, пока владелец не откроет черновик и не поднимет
// флаг, взять её нельзя никому.
//
// ПОЧЕМУ В ФОНЕ. Разбор идёт на локальной модели и занимает десятки секунд,
// а иногда упирается в двухминутный таймаут. Держать на нём HTTP-ответ на
// отправку сообщения нельзя: у владельца просто не отправлялось бы сообщение
// в чат, пока модель думает. Поэтому запись сообщения и разбор разведены —
// сообщение ложится сразу, разбор догоняет ответом в ту же ленту.
import crypto from "crypto";
import { spawn } from "child_process";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { broadcastToUsers } from "../ws.js";
import {
  claimDraftForParsing,
  type IntakeMode,
} from "../routes/task-intake.js";
import { dispatchTaskToPi } from "../routes/dispatch.js";
import { roleTitle } from "../roleRouting.js";
import {
  structureDictationToCards,
  type DictationCards,
} from "../routes/ai.js";
import { saveUploadedFile } from "../routes/attachments.js";

const uid = () => crypto.randomUUID();

/** Учётка, от чьего имени приходит ответ про собранную карточку. Заводится
 *  миграцией 028; это лицо в переписке, а не исполнитель. */
const SECRETARY_ID = "u-secretary";

/** Общий отправщик тревог машины (~/infra-ops/alert_send.py): повтор, журнал
 *  недоставленного и запасная дорога в Telegram мимо n8n. Он же — «пуш на
 *  телефон»: приложение владельца APNs-алертов не получает (ключ настроен
 *  только под островок, см. apns.ts), а Telegram доходит и на свёрнутом
 *  приложении. Свой упрощённый POST в вебхук здесь был бы третьей дорогой
 *  наружу без повтора и без учёта потерь — утренняя сводка считает их по
 *  журналу этого скрипта. */
const ALERT_SEND = `${process.env.HOME}/infra-ops/alert_send.py`;

export function ownerId(): string | null {
  const row = db
    .prepare(
      "SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1",
    )
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Пуш на телефон — отдельным процессом, fire-and-forget.
 *
 * Ни ошибка запуска, ни отсутствие скрипта не должны ронять разбор: карточка
 * к этому моменту уже создана, и потерять её из-за недоставленного
 * уведомления было бы хуже самого молчания. Скрипт лежит вне репозитория,
 * поэтому отношение к нему такое же мягкое, как у сторожей (см.
 * chat_resident_watch.py).
 *
 * ⛔ В тестах не отправляем — и это не косметика. Прогон 10.09.2026 разбудил
 * настоящий канал тревог, и владельцу прилетело в Telegram пять сообщений о
 * несуществующих карточках. Отправщик тут настоящий, общий для всей машины:
 * всё, что он умеет (повтор, запасная дорога), он проделает и с тестовыми
 * данными.
 */
function pushToPhone(title: string, text: string) {
  if (process.env.NODE_ENV === "test") return;
  try {
    const child = spawn(
      "python3",
      [
        ALERT_SEND,
        "--source",
        "taskflow-dictation",
        "--level",
        "info",
        "--title",
        title,
        "--text",
        text,
      ],
      { stdio: "ignore", detached: true },
    );
    child.on("error", (err) =>
      console.warn("окно постановки: пуш не ушёл:", err.message),
    );
    child.unref();
  } catch (err: any) {
    console.warn("окно постановки: пуш не запустился:", err?.message || err);
  }
}

/**
 * Ответ в ленту окна постановки — от «Секретаря», с привязкой к карточке.
 *
 * task_id у сообщения чата — уже готовый механизм (у сообщения есть поле,
 * клиент рисует по нему название карточки ссылкой), отдельной «ссылки» тут
 * изобретать не нужно.
 *
 * Рассылка — ТОЛЬКО владельцу: это его окно, и всякий, кому событие chat:new
 * долетело, просыпается (см. chat.ts, аудитория канала owner).
 */
function replyInChat(text: string, taskId: string | null) {
  const owner = ownerId();
  if (!owner) return;
  const id = uid();
  db.prepare(
    `INSERT INTO chat_messages (id, from_user_id, to_user_id, task_id, kind, text, channel)
     VALUES (?, ?, ?, ?, NULL, ?, 'owner')`,
  ).run(id, SECRETARY_ID, owner, taskId, text);

  const message = db
    .prepare(
      `SELECT m.*,
              f.name as from_user_name, f.avatar_color as from_user_color,
              f.avatar_url as from_user_avatar_url, f.initials as from_user_initials,
              d.name as to_user_name, d.avatar_color as to_user_color,
              t.title as task_title
         FROM chat_messages m
         LEFT JOIN users f ON f.id = m.from_user_id
         LEFT JOIN users d ON d.id = m.to_user_id
         LEFT JOIN tasks t ON t.id = m.task_id
        WHERE m.id = ?`,
    )
    .get(id);
  broadcastToUsers([owner], { type: "chat:new", message });
}

/** Строка очереди в описании дочерней карточки — тем же приёмом, каким
 *  владелец пишет её руками: «⛓ ОЧЕРЕДЬ: после карточки «…»». Отдельной
 *  таблицы зависимостей в трекере нет, и заводить её здесь — далеко за
 *  границами карточки; порядок между карточками живёт как договорённость в
 *  тексте плюс position внутри проекта. */
function queueLine(afterTitle: string): string {
  return `⛓ ОЧЕРЕДЬ: после карточки «${afterTitle}»`;
}

/** Критерий результата строкой в описании — тем же приёмом, что и очередь
 *  выше. Отдельной колонки под него в схеме нет, а заводить её значит
 *  править ещё и оба клиента, чтобы они её показали. Строка в описании
 *  видна везде сразу и переживает любой клиент.
 *
 *  Раздел 7 спецификации от 14.09.2026: критерий результата обязателен для
 *  каждой исполняемой карточки — по нему видно, сделана работа или нет. */
function resultLine(result: string): string {
  return `✅ РЕЗУЛЬТАТ: ${result}`;
}

/** Где делается работа — строкой в описании, тем же приёмом: агент на .110
 *  иначе не знает, что речь о приложении на iPhone, и делает в вебе. */
const WHERE_TITLES: Record<string, string> = {
  iphone: "приложение на iPhone",
  web: "веб",
  server: "сервер",
};
export function whereLine(where: string): string {
  return `📍 ГДЕ: ${WHERE_TITLES[where] ?? where}`;
}

/** Личное дело владельца (оплата, звонок, поездка) — агентам не отдаётся. */
function isPersonal(card: { where?: string | null }): boolean {
  return card.where === "личное";
}

/**
 * Роль, выбранная вместе с постановкой: в machine_selected_role (диспетчер
 * берёт её без пересчёта) и в ленту с причиной. Личное дело — исполнитель
 * сам владелец, чтобы автомат не отдал его агенту.
 */
function applyCardRole(
  taskId: string,
  card: { role?: string | null; roleReason?: string; where?: string | null },
  owner: string,
): void {
  if (isPersonal(card)) {
    db.prepare("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(owner, taskId);
    logEvent({
      taskId,
      actorId: null,
      kind: "role_choice",
      field: "assignee_id",
      toValue: "Личное дело — делаете вы, агентам не отдаётся.",
    });
    return;
  }
  if (!card.role) return;
  db.prepare("UPDATE tasks SET machine_selected_role = ? WHERE id = ?").run(
    card.role,
    taskId,
  );
  const reason = card.roleReason ? ` — ${card.roleReason}` : "";
  logEvent({
    taskId,
    actorId: null,
    kind: "role_choice",
    field: "machine_selected_role",
    toValue: `Роль «${roleTitle(card.role)}» подобрана при постановке${reason}.`,
  });
}

/** Русское склонение при числе: 1 карточка, 2 карточки, 5 карточек.
 *  Эти строки владелец читает в чате с телефона, и «2 карточка(и)» там
 *  выглядит как недоделка, а не как отчёт. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const last = mod100 % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/**
 * Создать черновик: родительская карточка, её шаги и дочерние карточки.
 *
 * Всё одной транзакцией: пачка карточек, из которой половина доехала, а
 * половина нет, — худший исход из возможных. Либо постановка есть целиком,
 * либо её нет и надиктовка цела.
 */
function createDraftCards(
  cards: DictationCards,
  owner: string,
): { parentId: string; childIds: string[] } {
  const parentId = uid();
  const childIds: string[] = cards.children.map(() => uid());

  const txn = db.transaction(() => {
    // ready_for_pickup не указываем — колонка стоит с DEFAULT 0 (миграция
    // 026), и это ровно то, что нужно: карточка машины лежит запертой, пока
    // владелец не поднимет флаг сам. Исполнителя тоже не назначаем: кому
    // делать — решает владелец, когда читает черновик.
    // needs_clarification/clarification_question — колонки уже есть в схеме
    // (миграция 030). Раздел 7 спецификации: карточка, по которой остался
    // вопрос, должна нести и признак, и сам вопрос, иначе автоматический
    // режим не поймёт, что дерево запускать нельзя.
    const insTask = db.prepare(
      `INSERT INTO tasks (id, title, description, due_date, project_id,
                          priority, creator_id, parent_id, position,
                          needs_clarification, clarification_question)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insSub = db.prepare(
      "INSERT INTO subtasks (id, task_id, title, position) VALUES (?, ?, ?, ?)",
    );

    // Критерий результата идёт в описание отдельной строкой — см.
    // resultLine. Для родителя он описывает общий результат дерева.
    const parentParts: string[] = [];
    if (cards.description) parentParts.push(cards.description);
    if (cards.result) parentParts.push(resultLine(cards.result));
    if (cards.where && !isPersonal(cards)) parentParts.push(whereLine(cards.where));

    insTask.run(
      parentId,
      cards.title,
      parentParts.length ? parentParts.join("\n\n") : null,
      cards.dueDate,
      cards.projectId,
      cards.priority,
      owner,
      null,
      null,
      cards.question ? 1 : 0,
      cards.question,
    );
    cards.subtasks.forEach((t, i) => insSub.run(uid(), parentId, t, i + 1));
    db.prepare("UPDATE tasks SET start_time=? WHERE id=?").run(cards.startTime ?? null,parentId);
    const insLabel = db.prepare("INSERT OR IGNORE INTO task_labels(task_id,label_id) VALUES (?,?)");
    for (const label of cards.labelIds ?? []) insLabel.run(parentId,label);


    cards.children.forEach((child, i) => {
      // Порядок между дочерними: position задаёт место в списке, а строка
      // очереди в описании — от какой карточки эта зависит. Модель называет
      // предшественницу номером в своём же списке (after), сверка на
      // осмысленность уже сделана в разборе.
      const parts: string[] = [];
      if (child.after !== null) {
        parts.push(queueLine(cards.children[child.after - 1].title));
      }
      if (child.description) parts.push(child.description);
      if (child.result) parts.push(resultLine(child.result));
      if (child.where && !isPersonal(child)) parts.push(whereLine(child.where));
      insTask.run(
        childIds[i],
        child.title,
        parts.length ? parts.join("\n\n") : null,
        null,
        cards.projectId,
        cards.priority,
        owner,
        parentId,
        i + 1,
        child.question ? 1 : 0,
        child.question,
      );
      db.prepare("UPDATE tasks SET due_date=?,start_time=? WHERE id=?").run(
        child.dueDate ?? cards.dueDate,child.startTime ?? cards.startTime ?? null,childIds[i]);
      for (const label of child.labelIds ?? cards.labelIds ?? []) insLabel.run(childIds[i],label);
      child.subtasks.forEach((t, j) =>
        insSub.run(uid(), childIds[i], t, j + 1),
      );
    });

    logEvent({
      taskId: parentId,
      actorId: owner,
      kind: "task_created",
      field: "task",
      toValue: cards.title,
    });
    if (cards.subtasks.length) {
      logEvent({
        taskId: parentId,
        actorId: owner,
        kind: "subtasks_seeded",
        field: "subtask",
        toValue: String(cards.subtasks.length),
      });
    }
    childIds.forEach((cid, i) => {
      logEvent({
        taskId: cid,
        actorId: owner,
        kind: "task_created",
        field: "task",
        toValue: cards.children[i].title,
      });
    });

    // Исполнители, выбранные вместе с постановкой, — после записей о
    // создании, чтобы лента читалась по порядку.
    applyCardRole(parentId, cards, owner);
    cards.children.forEach((child, i) => applyCardRole(childIds[i], isPersonal(cards) ? {...child,where:"личное"} : child, owner));
  });
  txn();

  return { parentId, childIds };
}

/**
 * Собрать постановку из ПРОИЗВОЛЬНОГО текста — заметка или файл, а не чат.
 * Тем же контуром, что и надиктовка (`structureDictationToCards`): локальная
 * модель → родитель + шаги + дочерние карточки со связью `parent_id`.
 *
 * НИЧЕГО не запускаем и в чат не пишем: карточки ложатся черновиком без флага
 * готовности (миграция 026) — владелец откроет и поднимет флаг сам. В этом и
 * смысл: большой текст (диалог, план) не влезает в чат, но структуру собирает
 * та же машина, что и надиктовку, с владельческим слоем `task_intake`.
 */
export async function createDraftFromText(
  rawText: string,
  owner: string,
): Promise<{ parentId: string; childIds: string[]; title: string }> {
  const projects = db
    .prepare("SELECT id, name FROM projects ORDER BY name")
    .all() as Array<{ id: string; name: string }>;
  const cards = await structureDictationToCards(rawText, projects, {
    ownerId: owner,
    maxChars: 12_000,
  });
  const { parentId, childIds } = createDraftCards(cards, owner);
  attachSourceText(rawText, parentId, owner, cards.title);
  return { parentId, childIds, title: cards.title };
}

/**
 * Прикрепить ИСХОДНЫЙ текст постановки к родительской карточке файлом .md.
 * Иначе задачи ссылаются на «предоставленный текст», которого в карточке нет
 * (жалоба владельца 20.09.2026): структура собрана, а контекст потерян.
 * Мягкая деградация: не смогли приложить — постановку не рушим.
 */
function attachSourceText(
  text: string,
  taskId: string,
  owner: string,
  title: string,
): void {
  try {
    const safeName = (title || "Исходный текст").slice(0, 80) + ".md";
    saveUploadedFile(
      {
        body: Buffer.from(text, "utf8"),
        name: encodeURIComponent(safeName),
        mime: "text/markdown",
      },
      (f) =>
        db
          .prepare(
            `INSERT INTO attachments (id, task_id, comment_id, kind, user_id, file_name, mime, size, stored_name)
             VALUES (?, ?, NULL, 'task', ?, ?, ?, ?, ?)`,
          )
          .run(f.id, taskId, owner, f.fileName, f.mime, f.size, f.storedName),
    );
  } catch {
    // контекст не приложился — это не повод терять постановку
  }
}

/**
 * Автоматический режим: поднять флаг готовности исполняемым карточкам и
 * отдать их Pi — без владельца (раздел 8.1 спецификации от 14.09.2026).
 *
 * Что считается исполняемой карточкой: если у постановки есть дети, то
 * работают именно они, а родитель остаётся контейнером общего результата
 * (раздел 6.3 — «родитель не исполняется одновременно с детьми»). Детей
 * нет — исполняется сама карточка.
 *
 * Флаг поднимается ВСЕМ исполняемым карточкам одной транзакцией: частичная
 * готовность дерева запрещена (раздел 12). А вот отдаются исполнителю
 * только карточки без незакрытой предшественницы — те, у которых в
 * постановке нет строки очереди. Остальные остаются готовыми и ждут своей
 * очереди: отдать их сразу означало бы запустить третий шаг раньше первого.
 */
async function admitTreeAutomatically(
  parentId: string,
  childIds: string[],
  cards: DictationCards,
  owner: string,
): Promise<{ dispatched: number; queued: number }> {
  // Исполняемые карточки и признак «есть предшественница».
  // Личные дела владельца (оплата, звонок, поездка) агентам не отдаются:
  // ни флага, ни раздачи — они остаются владельцу (23.09.2026).
  const executable: Array<{ id: string; waits: boolean }> = (childIds.length
    ? childIds.map((id, i) => ({
        id,
        waits: cards.children[i].after !== null,
        personal: isPersonal(cards) || isPersonal(cards.children[i]),
      }))
    : [{ id: parentId, waits: false, personal: isPersonal(cards) }]
  )
    .filter((card) => !card.personal)
    .map(({ id, waits }) => ({ id, waits }));

  // Флаг — одной транзакцией на всё дерево.
  const raise = db.transaction(() => {
    const upd = db.prepare(
      `UPDATE tasks
          SET ready_for_pickup = 1,
              ready_set_at = datetime('now'),
              ready_set_by = ?,
              updated_at = datetime('now')
        WHERE id = ?`,
    );
    for (const card of executable) {
      upd.run(owner, card.id);
      logEvent({
        taskId: card.id,
        actorId: null,
        kind: "ready_flag_changed",
        field: "ready_for_pickup",
        fromValue: "0",
        toValue: "1",
      });
    }
  });
  raise();

  let dispatched = 0;
  let queued = 0;
  for (const card of executable) {
    if (card.waits) {
      queued += 1;
      continue;
    }
    // Тот же путь, которым карточку отдаёт владелец руками: гейты и швы
    // доставки общие, иначе автомат начал бы запускать то, что вручную
    // запустить нельзя.
    const outcome = await dispatchTaskToPi(card.id, owner, { system: true });
    if (outcome.ok) {
      dispatched += 1;
    } else {
      // Карточка осталась готовой, но неотданной. Это не молчаливая
      // потеря: флаг поднят, владелец увидит её на доске как готовую без
      // исполнителя, а причина уходит в журнал сервера.
      queued += 1;
      console.warn(
        `автоматический режим: карточку ${card.id} не удалось отдать исполнителю:`,
        outcome.error,
      );
    }
  }

  return { dispatched, queued };
}

/** Человеческий пересказ того, что вышло, — им же уходит и в чат, и в пуш. */
function summary(cards: DictationCards): string {
  const bits = [`${cards.subtasks.length} шагов`];
  if (cards.children.length) bits.push(`${cards.children.length} дочерних`);
  const project = cards.projectId
    ? (
        db
          .prepare("SELECT name FROM projects WHERE id = ?")
          .get(cards.projectId) as { name: string } | undefined
      )?.name
    : null;
  if (project) bits.push(`проект «${project}»`);
  return bits.join(", ");
}

/**
 * Разобрать надиктовку и завести черновик. Вызывается из chat.ts и НИЧЕГО не
 * возвращает: отправку сообщения в чат разбор задерживать не должен.
 *
 * Повторная доставка того же сообщения второй карточки не заводит: строка в
 * chat_task_drafts ставится ДО обращения к модели и ключом идёт
 * chat_message_id, поэтому второй заход упирается в PRIMARY KEY и молча
 * уходит.
 */
/**
 * «✓ Идёт» на карточке Секретаря в чате (владелец 23.09.2026): запустить
 * черновик, не открывая задачу. Тем же порядком, что автоматика
 * (admitTreeAutomatically), но по данным из базы: исполняются дочерние, а
 * если их нет — сама карточка; личные дела (исполнитель — владелец) не
 * трогаем; ждущие очереди получают флаг, но отдаются, только когда дойдёт
 * их черёд (releaseQueuedSuccessors). Действие владельца — и в ленте от него.
 */
export async function startDraftTree(
  parentId: string,
  owner: string,
): Promise<{ started: number; queued: number } | null> {
  const parent = db
    .prepare("SELECT id, status, parent_id FROM tasks WHERE id = ?")
    .get(parentId) as { id: string; status: string; parent_id: string | null } | undefined;
  if (!parent || parent.status !== "active" || parent.parent_id) return null;

  type Row = {
    id: string;
    description: string | null;
    assignee_id: string | null;
    ready_for_pickup: number | null;
    status: string;
  };
  const children = db
    .prepare(
      `SELECT id, description, assignee_id, ready_for_pickup, status
         FROM tasks WHERE parent_id = ? ORDER BY position, created_at`,
    )
    .all(parentId) as Row[];
  const cards: Row[] = children.length
    ? children
    : [
        db
          .prepare(
            "SELECT id, description, assignee_id, ready_for_pickup, status FROM tasks WHERE id = ?",
          )
          .get(parentId) as Row,
      ];
  const executable = cards.filter(
    (c) =>
      c.status === "active" &&
      (c.ready_for_pickup ?? 0) === 0 &&
      c.assignee_id !== owner,
  );

  const raise = db.transaction(() => {
    const upd = db.prepare(
      `UPDATE tasks
          SET ready_for_pickup = 1,
              ready_set_at = datetime('now'),
              ready_set_by = ?,
              updated_at = datetime('now')
        WHERE id = ? AND ready_for_pickup = 0`,
    );
    for (const card of executable) {
      upd.run(owner, card.id);
      logEvent({
        taskId: card.id,
        actorId: owner,
        kind: "ready_flag_changed",
        field: "ready_for_pickup",
        fromValue: "0",
        toValue: "1",
      });
    }
  });
  raise();

  let started = 0;
  let queued = 0;
  for (const card of executable) {
    if (card.description?.includes("⛓ ОЧЕРЕДЬ:")) {
      queued += 1;
      continue;
    }
    if (card.assignee_id) {
      enqueueRoleRunJob({ taskId: card.id, reason: "assigned", actorId: owner,
        dedupeKey: `manual-start:${card.id}:${crypto.randomUUID()}`, manualStart: true });
      started += 1; // явный запуск назначенного исполнителя
      continue;
    }
    const outcome = await dispatchTaskToPi(card.id, owner, { manualStart: true });
    if (outcome.ok) started += 1;
    else console.warn(`запуск черновика: ${card.id} не отдан:`, outcome.error);
  }
  return { started, queued };
}

/** Общий путь постановки: сообщения и живой голос используют один разбор,
 *  слой task_intake, создание дерева и допуск. Режим фиксируется при приёме. */
export async function submitOwnerTaskText(rawText: string, owner: string, mode: IntakeMode) {
  const projects = db.prepare("SELECT id,name FROM projects ORDER BY name").all() as Array<{id:string;name:string}>;
  const cards = await structureDictationToCards(rawText, projects, {ownerId:owner});
  const {parentId,childIds} = createDraftCards(cards,owner);
  attachSourceText(rawText,parentId,owner,cards.title);
  const questions = [cards.question,...cards.children.map(c=>c.question)].filter((q):q is string=>!!q);
  const admission = mode === "automatic" && !questions.length
    ? await admitTreeAutomatically(parentId,childIds,cards,owner)
    : {dispatched:0,queued:0};
  return {parentId,childIds,cards,questions,...admission};
}

export function startDraftFromChat(message: {
  id: string;
  from_user_id: string;
  text: string;
}): void {
  const owner = ownerId();
  if (!owner || message.from_user_id !== owner) return;
  const text = (message.text || "").trim();
  if (!text) return;

  // Снимок режима берётся ДО обращения к модели и в той же строке
  // черновика, что и раньше служила защитой от повторной доставки. Если
  // владелец переключит тумблер, пока модель разбирает эту надиктовку,
  // судьба уже принятого сообщения не изменится (раздел 8.1 спецификации).
  let mode: IntakeMode;
  try {
    const claim = claimDraftForParsing(owner, message.id);
    // Строку создал не этот вызов — значит сообщение уже разбирается или
    // разобрано. Повтор молча глотаем, как и остальная дедупликация
    // доставки в проекте (agent_inbox по chat_message_id).
    if (!claim.claimed) return;
    mode = claim.mode;
  } catch {
    return;
  }

  void (async () => {
    try {
      const intake = await submitOwnerTaskText(text, owner, mode);
      const {parentId:taskId,childIds,cards} = intake;

      db.prepare(
        `UPDATE chat_task_drafts
            SET status = 'done', task_id = ?, finished_at = datetime('now')
          WHERE chat_message_id = ?`,
      ).run(taskId, message.id);

      const what = summary(cards);

      // Остался вопрос — дерево целиком остаётся черновиком, ни одна
      // карточка не запускается (раздел 8.1: «Если автоматический режим
      // обнаружил уточнение… всё дерево остаётся черновиком без флага.
      // Частичный запуск запрещён»). Запустить половину работы, пока
      // вторая половина непонятна, хуже, чем не запустить ничего: сделанное
      // придётся переделывать под ответ владельца.
      const вопросы = intake.questions;

      if (mode === "automatic" && вопросы.length) {
        const списком = вопросы.map((q) => `• ${q}`).join("\n");
        replyInChat(
          `Собрал постановку (${what}), но без ответа запускать не стал:\n` +
            `${списком}\n` +
            `Ответьте — и поднимите флаг, дальше пойдёт само.`,
          taskId,
        );
        pushToPhone(
          "TaskFlow: нужен ваш ответ",
          `«${cards.title}» — ${вопросы.length === 1 ? "остался вопрос" : "остались вопросы"}, работа не запущена.`,
        );
        return;
      }

      if (mode === "automatic") {
        // Автоматический режим: черновик владельцу не показывается и
        // подтверждения не ждёт (раздел 8.1 спецификации). Сервер сам
        // поднимает флаг и отдаёт работу — владелец узнаёт постфактум.
        const { dispatched, queued } = intake;
        const очередь = queued
          ? ` Ещё ${queued} ${plural(queued, "карточка ждёт", "карточки ждут", "карточек ждут")} своей очереди.`
          : "";
        replyInChat(
          `Принял в работу: ${what}. ` +
            `${dispatched} ${plural(dispatched, "карточка отдана", "карточки отданы", "карточек отдано")} исполнителю.${очередь}`,
          taskId,
        );
        pushToPhone(
          "TaskFlow: задача принята в работу",
          `«${cards.title}» — ${what}. Запущена автоматически, ваш флаг не нужен.`,
        );
        return;
      }

      replyInChat(
        `Собрал из надиктовки карточку-черновик: ${what}. ` +
          `Откройте, поправьте что не так и поставьте флаг готовности — ` +
          `до этого взять её никто не может.`,
        taskId,
      );
      pushToPhone(
        "TaskFlow: карточка из надиктовки",
        `«${cards.title}» — ${what}. Ждёт вашего флага готовности.`,
      );
    } catch (err: any) {
      // Отказ модели не должен стоить владельцу надиктовки: сообщение уже
      // лежит в ленте целым, здесь остаётся объяснить, почему карточки нет.
      // Причина пишется и в chat_task_drafts — по ней видно, что разбор
      // вообще пытались сделать, даже если ответ в чат почему-то не дошёл.
      const reason = String(err?.message || err || "неизвестная причина");
      db.prepare(
        `UPDATE chat_task_drafts
            SET status = 'failed', error = ?, finished_at = datetime('now')
          WHERE chat_message_id = ?`,
      ).run(reason, message.id);
      console.warn("окно постановки: разбор не удался:", reason);

      replyInChat(
        `Не смог собрать карточку: ${reason} ` +
          `Надиктовка цела — она выше в этой ленте. ` +
          `Можно попробовать ещё раз, отправив её повторно.`,
        null,
      );
      pushToPhone(
        "TaskFlow: карточка не собралась",
        `Разбор надиктовки не удался: ${reason} Сама надиктовка цела, лежит в чате.`,
      );
    }
  })();
}
