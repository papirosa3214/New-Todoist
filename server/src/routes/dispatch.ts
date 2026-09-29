// Карточка 5ceda583 — мост «owner поднял ready_for_pickup на задаче без
// исполнителя» → «канонический 8-ролевой выбор → запуск через Pi».
//
// Эта обязанность НЕ ложится на /api/tasks/:id/enrich (routes/enrichment.ts):
// тот мутирует ready_for_pickup прямо в обогащении (по сути — двух
// операций в одной транзакции), да ещё и возвращает архитектора первым
// всегда. Диспетчер — отдельная ось, и здесь он делает ровно одну вещь:
// фиксирует роль и отдаёт задачу единственному Pi runtime.
//
// Что делает endpoint:
//   1. Гейты: задача активна, ready_for_pickup=1, assignee_id IS NULL.
//      Чужое назначение не сбивается (защита от подмены уже розданной
//      работы), повторный dispatch — отказ (тот же защитный мотив, что и
//      у claim).
//   2. Выбирает роль: owner_selected_role → иначе «architect»
//      (дефолт-первый, чтобы поведение не менялось для уже
//      подготовленных карточек — ровно «returns architect first» из
//      описания дефекта, но теперь через явный шаг диспетчера).
//   3. Ставит assignee_id = Pi runtime, пишет dispatched_role/at/by,
//      отправляет notification (assigned) и agent_inbox (assignment) —
//      оба шва доставки должны сработать, иначе будильник задачу не
//      увидит (см. AGENT-PROTOCOL.md и логику trigger.py:
//      notification:new → handle_task).
//   4. ready_for_pickup НЕ трогает: это ось владельца, диспетчер её
//      не двигает, и повторное поднятие флага после отмены диспетчером
//      не должно стирать чужое решение.
//
// Реализация намеренно не вызывает существующий /enrich: тот мутирует
// readiness и смешивает концерны. Этот маршрут — единственная точка
// перехода «готовая карточка без исполнителя» → «у Пи».
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import { logEvent } from "../agentState.js";
import { broadcastTaskEvent, broadcastToUsers } from "../ws.js";
import { isServiceUser } from "./agent-state.js";
import { ROLE_NAMES, roleTitle, roleUserId, type RoleName } from "../roleRouting.js";
import { getTaskRow, hydrateTask } from "./tasks.js";
import { enqueueRoleRunJob } from "../runtime/roleRunQueue.js";

const uid = () => crypto.randomUUID();

// 8 исполнителей — по одному аккаунту на роль. Записи в users с
// role=researcher/.../designer и type=ai создаются миграцией 005; сюда
// попадает только их `id` (он же используется в assignee_id и user_id
// нотификаций/inbox/WS). Pi, который исполняет все 8 ролей одним
// рантаймом (миграция 005, role-routing.yaml → defaults: agent_pi),
// остаётся чисто внутренней механикой: наружу имя процесса не выходит,
// `assignee_id` всегда идёт на конкретного role-юзера. Это закрывает
// 14.09.2026: «В системе нет никакого „Pi“».
// Запасная роль — на случай, когда подобрать не удалось: семантика не
// ответила (Ollama недоступна) или вернула пусто. Не «роль по умолчанию
// для всех», а именно запасной вариант: до 14.09.2026 сюда попадало ВСЁ,
// и любая надиктовка уходила архитектору независимо от содержания.
const FALLBACK_DISPATCH_ROLE: RoleName = "architect";

/** Насколько уверенно подобрана роль — идёт в журнал карточки. */
export type RoleChoice = {
  role: RoleName | null;
  /** owner — выбрал владелец (owner_selected_role); machine — взяли
   *  ранее записанный machine_selected_role; semantic — подобрано по
   *  смыслу задачи после фильтра role_exclusions; fallback — подобрать
   *  не удалось, взят запасной вариант; dead — после фильтра
   *  role_exclusions кандидатов не осталось, role при этом null. */
  how: "owner" | "machine" | "semantic" | "fallback" | "dead";
  /** Близость к роли (0..1) для semantic; для остальных — null. */
  score: number | null;
  /** Отрыв от второй по близости роли: маленький отрыв означает, что
   *  выбор спорный, и владельцу стоит взглянуть. */
  margin: number | null;
};

/** Распарсить role_exclusions (TEXT, JSON-массив строк) из задачи. */
function parseRoleExclusions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Выбрать роль для карточки.
 *
 * Порядок из раздела 8.3 спецификации от 14.09.2026: ручное назначение
 * владельца имеет приоритет и повторной семантической замене не
 * подлежит; иначе работает подбор по смыслу.
 *
 * Второго алгоритма выбора здесь не заводится (раздел 7): используется
 * тот же семантический матчинг по role_embeddings, что и в обогащении.
 * Детерминированный enricher сюда не подходит — он подбирает СТАРЫЕ
 * личности (claude_bot, hermes, …), а не восемь канонических ролей, и
 * его ответ диспетчеру не на что положить.
 */
export async function pickRole(
  taskId: string,
  ownerSelected: string | null | undefined,
  machineSelected: string | null | undefined,
  roleExclusions: readonly string[] = [],
): Promise<RoleChoice> {
  // owner_selected_role валидируется на PATCH (миграция 038), здесь
  // проверка двойная — диспетчер не должен доверять колонке, если её
  // мог заполнить путь в обход роута (например, прямая правка БД).
  if (
    typeof ownerSelected === "string" &&
    (ROLE_NAMES as readonly string[]).includes(ownerSelected)
  ) {
    return {
      role: ownerSelected as RoleName,
      how: "owner",
      score: null,
      margin: null,
    };
  }

  // machine_selected_role — состоявшийся машинный выбор. Если он есть и
  // валиден, повторно гонять семантику не нужно: либо подбор сделан
  // раньше, либо его ещё не было и сейчас сделаем ниже.
  if (
    typeof machineSelected === "string" &&
    (ROLE_NAMES as readonly string[]).includes(machineSelected)
  ) {
    return {
      role: machineSelected as RoleName,
      how: "machine",
      score: null,
      margin: null,
    };
  }

  try {
    // ignoreGate: гейт эскалаций закрыт, пока эскалаций нет вовсе, а
    // другого источника роли у диспетчера не существует — с закрытым
    // гейтом он вечно ставил бы запасной вариант.
    // topK=8: просим все роли разом, чтобы потом отфильтровать exclusions
    // и взять первого подходящего.
    const { semanticEnrich } = await import("../lib/semanticEnrich.js");
    const result = await semanticEnrich(taskId, { topK: 8, ignoreGate: true });
    const exclusionSet = new Set(roleExclusions);
    const candidates = result.matched.filter(
      (m) =>
        (ROLE_NAMES as readonly string[]).includes(m.role) &&
        !exclusionSet.has(m.role),
    );
    if (candidates.length > 0) {
      const [top, second] = candidates;
      return {
        role: top.role as RoleName,
        how: "semantic",
        score: top.score,
        margin: second ? top.score - second.score : null,
      };
    }
    // Кандидаты кончились после фильтра — все роли либо не вернулись
    // семантикой, либо в exclusions. Это тупик, не fallback.
    if (exclusionSet.size > 0 && result.matched.length > 0) {
      return {
        role: null,
        how: "dead",
        score: null,
        margin: null,
      };
    }
  } catch (err) {
    // Подбор — улучшение, а не условие запуска. Модель эмбеддингов
    // недоступна — работа всё равно должна уехать исполнителю, пусть и
    // с запасной ролью.
    console.warn(`подбор роли для ${taskId} не удался:`, err);
  }

  return {
    role: FALLBACK_DISPATCH_ROLE,
    how: "fallback",
    score: null,
    margin: null,
  };
}

/** Человеческие имена ролей — владелец читает ленту, а не наши
 *  идентификаторы. Порядок и состав — раздел 4.2 спецификации. */
/** Строка для ленты: какая роль и почему именно она. */
export function roleChoiceNoteRu(choice: RoleChoice): string {
  if (choice.how === "dead" || choice.role === null) {
    // Достижимо только при how="dead". Возвращаем осмысленный текст для
    // ленты — отдельная ветка нужна, чтобы «имя» не упало на null.
    return "Подобрать роль не удалось — все кандидаты исключены.";
  }
  const имя = roleTitle(choice.role);
  if (choice.how === "owner") {
    return `Роль «${имя}» — выбрана вами.`;
  }
  if (choice.how === "fallback") {
    return `Роль «${имя}» — подобрать по смыслу не вышло, взял запасной вариант.`;
  }
  // machine / semantic — один текст: «подобрана автоматически». Для
  // machine дополнительно отметим, что подбор был сделан раньше
  // диспетчером (а не здесь и сейчас).
  if (choice.how === "machine") {
    return `Роль «${имя}» — подобрана автоматически.`;
  }
  // Маленький отрыв от второй роли означает, что выбор спорный: две роли
  // подошли почти одинаково. Владельцу стоит взглянуть, поэтому говорим
  // об этом прямо, а не прячем за числом.
  const спорно =
    choice.margin !== null && choice.margin < 0.03
      ? " Выбор неочевидный — рядом стояла другая роль, посмотрите, если важно."
      : "";
  return `Роль «${имя}» — подобрана автоматически.${спорно}`;
}

/** Чем кончилась попытка отдать карточку Pi. */
export type DispatchOutcome =
  { ok: true; role: RoleName } | { ok: false; code: number; error: string };

/**
 * Ядро диспетчера: гейты, фиксация роли, назначение Pi и оба шва доставки.
 *
 * Вынесено из маршрута, потому что путей сюда два, а правила допуска должны
 * быть одни (раздел 8.2 спецификации от 14.09.2026):
 *   - ручной режим: владелец нажал «отдать в работу» → HTTP-маршрут ниже;
 *   - автоматический: конвейер надиктовки сам поднял флаг и зовёт эту же
 *     функцию напрямую, без похода в собственный HTTP.
 * Если бы автоматика ходила своим путём, гейты неизбежно разъехались бы —
 * и «автомат» начал бы запускать то, что руками запустить нельзя.
 *
 * Гейт «только владелец» сюда НЕ входит: он про того, кто нажимает, и
 * живёт в маршруте. Здесь — про состояние карточки.
 */
export async function dispatchTaskToPi(
  taskId: string,
  actorId: string,
  // `system` — раздачу сделала автоматика, а не человек: в ленте она
  // подписывается «Система», а не владельцем (владелец 22.09.2026: «надо
  // писать, кто это делает»). Уведомление исполнителю по-прежнему идёт от
  // actorId — по нему будильник ловит назначение.
  opts: { system?: boolean; manualStart?: boolean } = {},
): Promise<DispatchOutcome> {
  const eventActor = opts.system ? null : actorId;
  const task = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(taskId) as any;
  if (!task) {
    return { ok: false, code: 404, error: "Not found" };
  }
  if (task.status !== "active") {
    return {
      ok: false,
      code: 400,
      error: "отдать задачу исполнителю можно только пока она активна",
    };
  }
  if ((task.ready_for_pickup ?? 0) !== 1) {
    return {
      ok: false,
      code: 400,
      error:
        "задача ещё не готова к отдаче: владелец не поднял флаг готовности",
    };
  }
  if (task.assignee_id) {
    return {
      ok: false,
      code: 400,
      error:
        "у задачи уже назначен исполнитель — диспетчер не отдаёт чужую работу",
    };
  }

  // Подбор роли — ДО транзакции: он ходит за эмбеддингами по сети, а
  // держать на этом write-лок SQLite нельзя.
  // Приоритет: owner_selected_role → machine_selected_role → семантика.
  // Кандидаты фильтруются по role_exclusions; если после фильтра ничего
  // не осталось — how="dead", и отдавать задачу нельзя.
  const choice = await pickRole(
    taskId,
    task.owner_selected_role,
    task.machine_selected_role,
    parseRoleExclusions(task.role_exclusions),
  );
  if (choice.how === "dead" || choice.role === null) {
    return {
      ok: false,
      code: 400,
      error: "нет кандидатов: все роли либо не подошли, либо исключены",
    };
  }
  const chosen = choice.role;

  const rejectionRef: { current: { code: number; error: string } | null } = {
    current: null,
  };
  const txn = db.transaction(() => {
    // Перечитываем строку под транзакцией: между SELECT выше и моментом
    // захвата write-лока кто-то мог успеть назначить исполнителя.
    // Повторный dispatch в таком случае — отказ, без затирания чужого
    // решения.
    const latest = db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(taskId) as any;
    if (!latest) {
      rejectionRef.current = { code: 404, error: "Not found" };
      return;
    }
    if (latest.status !== "active") {
      rejectionRef.current = {
        code: 400,
        error: "задача больше не активна — диспетчер не отдаёт её",
      };
      return;
    }
    if ((latest.ready_for_pickup ?? 0) !== 1) {
      rejectionRef.current = {
        code: 400,
        error: "задача больше не готова к отдаче",
      };
      return;
    }
    if (latest.assignee_id) {
      rejectionRef.current = {
        code: 400,
        error: "у задачи уже есть исполнитель — гонка за dispatch проиграна",
      };
      return;
    }

    const previousRole = latest.dispatched_role ?? null;

    db.prepare(
      `UPDATE tasks
          SET assignee_id = ?,
              dispatched_role = ?,
              dispatched_at = datetime('now'),
              dispatched_by = ?,
              updated_at = datetime('now')
        WHERE id = ?`,
    ).run(roleUserId(chosen), chosen, actorId, taskId);

    logEvent({
      taskId,
      actorId: eventActor,
      kind: "task_dispatched",
      field: "dispatched_role",
      fromValue: previousRole,
      toValue: chosen,
    });

    // Как именно выбрана роль — в ленту карточки, человеческими словами
    // (раздел 13 спецификации: «причины выбора каждой роли и confidence,
    // источник назначения suggested или manual»). Владелец должен видеть
    // разницу между «я сам выбрал», «подобралось по смыслу» и «подобрать
    // не вышло, взяли запасной вариант» — иначе непонятно, почему работа
    // ушла именно туда, и спорный выбор нечем заметить.
    logEvent({
      taskId,
      actorId: eventActor,
      kind: "role_choice",
      field: "dispatched_role",
      fromValue: null,
      toValue: roleChoiceNoteRu(choice),
    });

    // Notification — основной шов, через него будильник ловит назначение.
    const notifId = uid();
    db.prepare(
      `INSERT INTO notifications (id, user_id, type, task_id, text, actor_id)
       VALUES (?, ?, 'assigned', ?, ?, ?)`,
    ).run(
      notifId,
      roleUserId(chosen),
      taskId,
      `Новая задача назначена: ${(latest.title || taskId).slice(0, 200)}`,
      actorId,
    );

    // Inbox-событие — второй шов доставки (карточка 5f292e87).
    const inboxId = uid();
    db.prepare(
      `INSERT INTO agent_inbox
         (id, chat_message_id, to_user_id, body_text, task_id, task_version,
          kind, event_type, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'text', 'assignment', 'sent', datetime('now'))`,
    ).run(
      inboxId,
      `dispatch-${inboxId}`,
      roleUserId(chosen),
      `Вам назначена задача «${(latest.title || taskId).slice(0, 120)}» (роль ${chosen}).`,
      taskId,
      Number(latest.current_revision ?? 1),
    );

    // Назначение и повод запуска — одна SQLite-транзакция. Если процесс
    // упадёт после commit, durable worker подберёт job после рестарта.
    enqueueRoleRunJob({
      taskId,
      reason: "assigned",
      actorId,
      dedupeKey: `dispatch:${inboxId}`,
      manualStart: opts.manualStart ?? false,
    });

    broadcastToUsers([roleUserId(chosen)], {
      type: "notification:new",
      notificationId: notifId,
      taskId,
    });
  });
  txn();

  if (rejectionRef.current) {
    return {
      ok: false,
      code: rejectionRef.current.code,
      error: rejectionRef.current.error,
    };
  }

  const updated = getTaskRow(taskId);
  broadcastTaskEvent([updated.creator_id, updated.assignee_id], {
    type: "task:updated",
    task: hydrateTask(updated),
  });

  return { ok: true, role: chosen };
}

/**
 * Отпустить следующие карточки очереди после закрытия предшественницы.
 *
 * Зачем: автоматический режим поднимает флаг всему дереву, но отдаёт
 * исполнителю только карточки без незакрытой предшественницы — иначе
 * второй шаг поехал бы раньше первого. Без этой функции такие карточки
 * висели бы готовыми навсегда: автомат делал ровно один шаг дерева и
 * вставал, а владелец видел «готово, но никто не берёт».
 *
 * Зависимость между дочерними карточками живёт строкой в описании
 * («⛓ ОЧЕРЕДЬ: после карточки «…»») — отдельной таблицы зависимостей в
 * трекере нет (см. queueLine в lib/ownerDraft.ts). Поэтому и ищем по ней,
 * а не по несуществующему графу.
 *
 * Карточку, которой владелец не поднимал флаг, функция не трогает: гейт
 * готовности проверяет dispatchTaskToPi. В ручном режиме это значит, что
 * очередь не поедет сама, и так и задумано — там запускает владелец.
 */
/**
 * Приём любой новой задачи — не только надиктованной.
 *
 * Владелец 14.09.2026: «исполнитель подбирается сразу при создании ЛЮБОЙ
 * задачи ЛЮБЫМ способом; в ручном режиме она показывается мне, в
 * автоматическом — улетает в работу; регулятором выступает флаг».
 *
 * До этого подбор и отдача висели ТОЛЬКО на конвейере надиктовки: задача,
 * заведённая руками, исполнителя не получала вовсе, а после поднятия флага
 * всё равно стояла, пока владелец не нажимал «отдать в работу» отдельно.
 * Тумблер режима на неё не влиял никак. Разделение было случайным —
 * автоматику писали внутри голосового конвейера, и она осталась его частью.
 *
 * Здесь подбор пишется в owner_selected_role: это же поле владелец правит
 * руками, и оно уже имеет приоритет в pickRole. То есть предложение видно
 * до флага, заменяется одним движением, а согласие ничего делать не
 * требует. Ленту это не обманывает — там пишется, что роль подобрана по
 * смыслу, а не выбрана владельцем.
 *
 * Роль НЕ трогается, если владелец уже выбрал её сам или если исполнитель
 * уже назначен: чужое решение диспетчер не переписывает.
 */
export async function applyIntakeToNewTask(
  taskId: string,
  actorId: string,
): Promise<void> {
  // Режим — настройка ВЛАДЕЛЬЦА, а не того, кто завёл карточку. Читать его
  // у создателя было ошибкой: задачу может завести агент или внешний вызов,
  // и у них всегда стоит ручной режим по умолчанию. Владелец включил
  // автоматический — значит система работает автоматически, кто бы задачу
  // ни создал (поймано на живом прогоне 14.09.2026: у владельца стоял
  // «Автомат», а заведённая мной карточка осталась ждать флага).
  const ownerRow = db
    .prepare(
      "SELECT id, task_intake_mode FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1",
    )
    .get() as { id: string; task_intake_mode?: string } | undefined;
  if (!ownerRow) return;
  const ownerId = ownerRow.id;
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
  if (!task || task.status !== "active") return;
  // Родитель-контейнер сам не исполняется (раздел 6.3): работу делают дети.
  const hasChildren = (
    db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?").get(taskId) as any
  )?.n;
  if (hasChildren) return;
  // Назначенный исполнитель раньше означал полный выход — и карточка,
  // заведённая сразу с исполнителем, проходила мимо приёма целиком: без
  // флага, а значит и без возможности взять её в работу. Чужое назначение
  // мы по-прежнему не трогаем, но это про подбор роли и раздачу; режим
  // владельца должен действовать одинаково, кем бы карточка ни была
  // заведена и с исполнителем она или без.
  const assigneeAlreadySet = Boolean(task.assignee_id);

  // Владелец 19.09.2026: автоназначение роли привязано к БУДИЛЬНИКУ.
  // Выключен — назначать некому и незачем (никого не разбудят); тогда
  // карточка не получает ни подбора роли, ни раздачи, только флаг
  // (если режим автоматический), чтобы её взяли руками.
  const { unitState } = await import("./agent-service.js");
  const alarmOn = (await unitState()).active;

  // Тот же подбор, что у Секретаря (23.09.2026): модель читает карточку и
  // говорит, кто её делает, почему и где. Личное дело остаётся владельцу —
  // без флага и раздачи, как у постановки Секретаря.
  const exclusions = parseRoleExclusions(task.role_exclusions);
  let modelPick: Awaited<ReturnType<typeof import("./ai.js").pickRoleByModel>> = null;
  if (!assigneeAlreadySet && !task.owner_selected_role) {
    const { pickRoleByModel } = await import("./ai.js");
    const steps = (
      db
        .prepare("SELECT title FROM subtasks WHERE task_id = ? ORDER BY position")
        .all(taskId) as Array<{ title: string }>
    ).map((r) => r.title);
    modelPick = await pickRoleByModel(
      { title: task.title ?? "", description: task.description, subtasks: steps },
      ownerId,
    );
    if (modelPick?.where === "личное") {
      db.prepare(
        "UPDATE tasks SET assignee_id = ?, updated_at = datetime('now') WHERE id = ? AND assignee_id IS NULL",
      ).run(ownerId, taskId);
      logEvent({
        taskId,
        actorId: null,
        kind: "role_choice",
        field: "assignee_id",
        toValue: "Личное дело — делаете вы, агентам не отдаётся.",
      });
      return;
    }
    if (modelPick?.where) {
      const { whereLine } = await import("../lib/ownerDraft.js");
      db.prepare(
        `UPDATE tasks
            SET description = CASE WHEN description IS NULL OR description = ''
                                   THEN ? ELSE description || char(10) || char(10) || ? END
          WHERE id = ?`,
      ).run(whereLine(modelPick.where), whereLine(modelPick.where), taskId);
    }
  }

  if (
    alarmOn &&
    !assigneeAlreadySet &&
    !task.owner_selected_role &&
    modelPick?.role &&
    !exclusions.includes(modelPick.role)
  ) {
    db.prepare(
      `UPDATE tasks SET machine_selected_role = ?, updated_at = datetime('now')
        WHERE id = ? AND assignee_id IS NULL`,
    ).run(modelPick.role, taskId);
    const reason = modelPick.roleReason ? ` — ${modelPick.roleReason}` : "";
    logEvent({
      taskId,
      actorId: null,
      kind: "role_choice",
      field: "machine_selected_role",
      toValue: `Роль «${roleTitle(modelPick.role)}» подобрана по сути работы${reason}.`,
    });
  } else if (alarmOn && !assigneeAlreadySet && !task.owner_selected_role) {
    // Подбираем роль и пишем в machine_selected_role. Роутер НИКОГДА не
    // пишет в owner_selected_role — это поле только владельца
    // (см. taskflow-pipeline-head-plan.md, шаг 1).
    const choice = await pickRole(
      taskId,
      task.owner_selected_role,
      task.machine_selected_role,
      exclusions,
    );
    if (choice.how === "dead" || choice.role === null) {
      // Кандидатов нет — задача в тупике. Планировщик (шаг 4) увидит
      // block_type='dead' и пришлёт владельцу уведомление.
      db.prepare(
        `UPDATE tasks
            SET block_type = 'dead',
                blocked_reason = ?,
                updated_at = datetime('now')
          WHERE id = ? AND assignee_id IS NULL`,
      ).run(
        "при создании: нет кандидатов — все роли либо не подошли, либо исключены",
        taskId,
      );
      logEvent({
        taskId,
        actorId: null,
        kind: "field_changed",
        field: "block_type",
        toValue: "dead",
      });
    } else {
      db.prepare(
        `UPDATE tasks SET machine_selected_role = ?, updated_at = datetime('now')
          WHERE id = ? AND assignee_id IS NULL`,
      ).run(choice.role, taskId);
      logEvent({
        taskId,
        actorId: null,
        kind: "field_changed",
        field: "machine_selected_role",
        toValue: roleChoiceNoteRu(choice),
      });
    }
  }

  const mode = ownerRow.task_intake_mode;
  // Ручной режим на этом и останавливается: задача с предложенным
  // исполнителем ждёт владельца. Взять её всё равно нельзя — claim
  // требует флага.
  if (mode !== "automatic") return;

  // Владелец 30.09.2026: если карточке уже предложен план совместной работы
  // (draft, ждёт решения владельца) — не отдавать её тут же одному
  // исполнителю. Раньше план и обычная раздача гонялись наперегонки: план
  // просто предложение, а раздача синхронная и срабатывала первой — план
  // так и висел неутверждённым черновиком рядом с уже занятой карточкой
  // (прецедент: «Добавить бейдж…», T03 предложен, но раздача забрала
  // карточку одному дизайнеру раньше, чем владелец успел решить). Теперь
  // ровно один из двух путей: «Утвердить план»
  // (/collaboration-plans/:id/approve) или «Запустить исполнителя» (тот же
  // PATCH ready_for_pickup, что и раньше, см. routes/tasks.ts) — выбор
  // одного гасит другой (approve требует status='draft'; ручной запуск
  // сам переводит план в 'superseded').
  const pendingPlan = db
    .prepare("SELECT 1 FROM task_collaboration_plans WHERE task_id = ? AND status = 'draft'")
    .get(taskId);
  if (pendingPlan) return;

  const flagged = db.prepare(
    `UPDATE tasks
        SET ready_for_pickup = 1,
            ready_set_at = datetime('now'),
            ready_set_by = ?,
            updated_at = datetime('now')
      WHERE id = ? AND ready_for_pickup = 0`,
  ).run(ownerId, taskId);
  // Раньше флаг здесь ставился молча — в ленте не было видно, когда и кем
  // карточка отмечена готовой. Ставит его система, не владелец.
  if (flagged.changes > 0) {
    logEvent({
      taskId,
      actorId: null,
      kind: "ready_flag_changed",
      field: "ready_for_pickup",
      fromValue: "0",
      toValue: "1",
    });
  }
  // Раздача (проставление исполнителя) — только когда будильник жив:
  // назначить агента, которого некому разбудить, смысла нет.
  // Раздача — только для карточки без исполнителя: dispatchTaskToPi и сам
  // откажется отдавать чужую работу, но звать его впустую незачем.
  if (alarmOn && !assigneeAlreadySet) await dispatchTaskToPi(taskId, ownerId, { system: true });
}

/**
 * Родитель со СВОИМИ пунктами тоже исполняется — после дочерних.
 *
 * Владелец 22.09.2026: секретарь завёл родителя с двумя дочерними и пунктом
 * у самого родителя («проверить интеграцию…»). Приём флаг родителю не
 * ставит (он контейнер, см. applyIntakeToNewTask), и пункт некому было
 * выполнить — владелец поднял флаг руками, когда обе дочерние сдали работу.
 * Теперь это делает сервер: как только ВСЕ дочерние на проверке или
 * закрыты, а у родителя есть невыполненные пункты, родитель получает флаг
 * и уходит исполнителю — тем же путём, что и при создании.
 *
 * Только в автоматическом режиме: в ручном флаг — решение владельца.
 * Родитель без своих пунктов не трогается: делать ему нечего, он сам уйдёт
 * на проверку сводкой, когда дочерние закроют (routes/tasks.ts).
 *
 * Вызывается после каждого перехода дочерней в review / completed. Не
 * бросает: это следствие чужого перехода, а не его часть.
 */
export async function admitParentAfterChildren(
  childTaskId: string,
): Promise<boolean> {
  const child = db
    .prepare("SELECT parent_id FROM tasks WHERE id = ?")
    .get(childTaskId) as { parent_id: string | null } | undefined;
  const parentId = child?.parent_id;
  if (!parentId) return false;

  const ownerRow = db
    .prepare(
      "SELECT id, task_intake_mode FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1",
    )
    .get() as { id: string; task_intake_mode?: string } | undefined;
  if (!ownerRow || ownerRow.task_intake_mode !== "automatic") return false;

  const parent = db
    .prepare(
      "SELECT id, status, ready_for_pickup, agent_state, assignee_id FROM tasks WHERE id = ?",
    )
    .get(parentId) as
    | {
        id: string;
        status: string;
        ready_for_pickup: number | null;
        agent_state: string | null;
        assignee_id: string | null;
      }
    | undefined;
  if (!parent || parent.status !== "active") return false;
  if ((parent.ready_for_pickup ?? 0) === 1 || parent.agent_state) return false;
  // Родитель — личное дело владельца: его пункты делает он сам.
  if (parent.assignee_id === ownerRow.id) return false;

  const openSteps = (
    db
      .prepare("SELECT COUNT(*) AS n FROM subtasks WHERE task_id = ? AND done = 0")
      .get(parentId) as { n: number }
  ).n;
  if (!openSteps) return false;

  const children = db
    .prepare("SELECT status, agent_state FROM tasks WHERE parent_id = ?")
    .all(parentId) as Array<{ status: string; agent_state: string | null }>;
  const allSubmitted =
    children.length > 0 &&
    children.every((c) => c.status === "completed" || c.agent_state === "review");
  if (!allSubmitted) return false;

  const raised = db.transaction(() => {
    const r = db
      .prepare(
        `UPDATE tasks
            SET ready_for_pickup = 1,
                ready_set_at = datetime('now'),
                ready_set_by = ?,
                updated_at = datetime('now')
          WHERE id = ? AND ready_for_pickup = 0`,
      )
      .run(ownerRow.id, parentId);
    if (r.changes > 0) {
      logEvent({
        taskId: parentId,
        actorId: null,
        kind: "ready_flag_changed",
        field: "ready_for_pickup",
        fromValue: "0",
        toValue: "1",
      });
    }
    return r.changes > 0;
  })();
  if (!raised) return false;

  // Раздача — как при создании: только без исполнителя и при живом
  // будильнике (назначать агента, которого некому разбудить, незачем).
  if (!parent.assignee_id) {
    const { unitState } = await import("./agent-service.js");
    if ((await unitState()).active) {
      const outcome = await dispatchTaskToPi(parentId, ownerRow.id, {
        system: true,
      });
      if (!outcome.ok) {
        console.warn(
          `родитель ${parentId}: флаг поднят, отдать не удалось:`,
          outcome.error,
        );
      }
    }
  }
  return true;
}

export async function releaseQueuedSuccessors(
  completedTaskId: string,
  actorId: string,
): Promise<number> {
  const completed = db
    .prepare("SELECT id, title, parent_id FROM tasks WHERE id = ?")
    .get(completedTaskId) as
    { id: string; title: string | null; parent_id: string | null } | undefined;
  // Очередь существует только между дочерними карточками одного дерева.
  if (!completed?.parent_id || !completed.title) return 0;

  const marker = `⛓ ОЧЕРЕДЬ: после карточки «${completed.title}»`;

  const siblings = db
    .prepare(
      `SELECT id, description, ready_for_pickup, assignee_id, status
         FROM tasks
        WHERE parent_id = ? AND id <> ?`,
    )
    .all(completed.parent_id, completed.id) as Array<{
    id: string;
    description: string | null;
    ready_for_pickup: number | null;
    assignee_id: string | null;
    status: string;
  }>;

  let released = 0;
  for (const sibling of siblings) {
    // Сверяем подстроку в JS, а не через LIKE: название карточки пишет
    // модель, в нём легко встретится и кавычка, и процент, и подчёркивание
    // — экранировать их в SQL дороже и ошибочнее, чем сравнить здесь.
    if (!sibling.description?.includes(marker)) continue;
    if (sibling.status !== "active") continue;
    if ((sibling.ready_for_pickup ?? 0) !== 1) continue;
    if (sibling.assignee_id) continue;

    const outcome = await dispatchTaskToPi(sibling.id, actorId, {
      system: true,
    });
    if (outcome.ok) {
      released += 1;
    } else {
      // Не молчим: карточка осталась готовой и видимой на доске, но
      // причина, по которой её не удалось отдать, должна быть в журнале.
      console.warn(
        `очередь: карточку ${sibling.id} не удалось отдать после закрытия ${completedTaskId}:`,
        outcome.error,
      );
    }
  }

  return released;
}

export function registerDispatchRoutes(app: FastifyInstance): void {
  const authPre = authOrApiToken;

  // POST /api/tasks/:id/dispatch — отдать готовую карточку без исполнителя
  // единственному Pi runtime с зафиксированной ролью. Атомарно: гейты,
  // фиксация роли, assignee, оба шва доставки и широковещание.
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/dispatch",
    { preHandler: authPre },
    async (req: any, reply) => {
      const { id } = req.params;

      // ГЕЙТ 1: только владелец. Это единственный гейт, который живёт в
      // маршруте, — он про того, КТО нажимает. Гейты состояния карточки
      // (активна, поднят флаг, свободен исполнитель) живут в
      // dispatchTaskToPi, потому что их обязан проходить и автоматический
      // режим, который сюда по HTTP не ходит.
      if (!isOwner(req.userId)) {
        return reply.code(403).send({
          error:
            "отдать готовую задачу исполнителю может только владелец трекера",
        });
      }

      const outcome = await dispatchTaskToPi(id, req.userId, { manualStart: true });
      if (!outcome.ok) {
        return reply.code(outcome.code).send({ error: outcome.error });
      }

      return { task: hydrateTask(getTaskRow(id)) };
    },
  );

  // POST /api/tasks/:id/repick-role — планировщик (шаг 4) просит
  // переподобрать роль для blocked/wrong_role карточки. Только service user.
  // Возвращает { role, how } или { role: null, how: "dead" } если кандидатов
  // нет после role_exclusions.
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/repick-role",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isServiceUser(req.userId)) {
        return reply.code(403).send({
          error: "repick-role доступен только служебному ключу (планировщик)",
        });
      }
      const task = db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(req.params.id) as any;
      if (!task) return reply.code(404).send({ error: "Not found" });
      const choice = await pickRole(
        req.params.id,
        task.owner_selected_role,
        task.machine_selected_role,
        parseRoleExclusions(task.role_exclusions),
      );
      return choice;
    },
  );
}
