// Shared object-ownership lookups. A row is returned only if the caller may
// touch it, so callers can do `if (!row) return 404` without repeating the
// predicate everywhere.
//
// ─────────────────────────────────────────────────────────────────────────
// Правило доступа (формулировка владельца, 18.08.2026)
//
//   «Человек-владелец видит всё и вся и может залезать куда угодно — полный
//    карт-бланш. Агенты тоже видят всё, но не лезут в те задачи, которые им
//    не назначили».
//
// Отсюда три круга, а не один:
//
//   role='owner'  — владелец трекера. Читает и меняет что угодно.
//   role='orchestrator'
//                 — оркестратор: ведёт работу ботов. Читает и правит любые
//                   проекты и задачи, назначает исполнителей, заводит
//                   подзадачи — как владелец, но БЕЗ права удаления
//                   (задача af2107b2, 28.08.2026). Запрет на удаление
//                   стоит одной дверью в authOrApiToken (auth.ts) и
//                   накрывает все DELETE разом; поэтому здесь, в access.ts,
//                   оркестратору расширены только чтение и правка, а
//                   функции поиска «что можно удалить» оставлены как были —
//                   два слоя говорят одно и то же.
//   type='ai'     — агент. Заводится ТОЛЬКО владельцем (POST /api/agents),
//                   регистрация такую учётку выдать не может (auth.ts).
//                   Читает всё, меняет лишь то, что создал сам или что ему
//                   назначили.
//   остальные     — человек, зарегистрировавшийся сам. Для него всё как
//                   раньше: своё создал / своё назначено / свой проект.
//                   Регистрация на :5180 открыта, поэтому «видно всё» на
//                   этот круг не распространяется.
//
// До 18.08.2026 роль не проверялась НИГДЕ, доступ считался только по
// владению объектом — и задача, которую агент завёл сам, у владельца не
// показывалась вообще: ни creator, ни assignee, ни проект на него не
// указывали. Три такие задачи нашлись в живой базе.
// ─────────────────────────────────────────────────────────────────────────
import db from "./db.js";

type Caller = { role?: string; type?: string; reviewer?: number; profile?: string | null };

function callerOf(userId: string): Caller | undefined {
  return db.prepare("SELECT role, type, reviewer, profile FROM users WHERE id = ?").get(userId) as
    Caller | undefined;
}

/**
 * Маппинг профиль исполнителя (users.profile, заполняется из
 * server/scripts/team_catalog.json по id) → роль из восьми ролей матрицы
 * прав карточки b6b57092 (Architect / Builder / QA / Researcher / Analyst
 * / Synthesizer / Critic-Verifier). Договоренность с владельцем 11.09.2026:
 * маппинг может быть любой чёткий, источник истины — здесь, потому что
 * team_catalog.json описывает компетенции исполнителей, а не роли для
 * проверки прав; править здесь дешевле, чем плодить ещё одно поле.
 *
 * Не покрыто:
 *   maxim         → role='owner' (отдельная ветка, не из восьми).
 *   u-secretary   → profile=NULL (нет в team_catalog.json; роль не
 *                   назначается, проверки идут по role/type).
 *
 * QA и Critic/Verifier совмещены (решение владельца 11.09.2026): профиль
 * reviewer закрывает обе функции — узкая роль Critic/Verifier покрывает и
 * вынесение вердикта, и QA-проверку.
 */
const PROFILE_ROLE: Record<string, string> = {
  claude_bot: "Builder",
  hermes: "Builder",
  antigravity: "Builder",
  pi_agent: "Builder",
  deepseek: "Researcher",
  reviewer: "Critic/Verifier",
  critic_verifier: "Critic/Verifier",
  orchestrator: "Architect",
};

/**
 * Роль из восьми ролей для учётки. Берёт users.profile, лезет в маппинг.
 * Возвращает null если профиль пуст или в маппинге не описан — это
 * текущее поведение «профиль ещё не проставлен», ничего не ломает, как
 * требует граница карточки «до заполнения профиля поведение остаётся
 * прежним».
 */
export function getRole(userId: string): string | null {
  const profile = callerOf(userId)?.profile ?? null;
  if (!profile) return null;
  return PROFILE_ROLE[profile] ?? null;
}

/** Владелец трекера — карт-бланш на чтение и на правку. */
export function isOwner(userId: string): boolean {
  return callerOf(userId)?.role === "owner";
}

/**
 * Оркестратор — распорядитель работы ботов.
 *
 * Читает и правит что угодно наравне с владельцем, но не удаляет ничего:
 * он раздаёт и переставляет работу, а решение «этого больше не нужно»
 * остаётся за человеком. Отказ выдаётся раньше роутов — в authOrApiToken
 * (auth.ts), на любой DELETE.
 */
export function isOrchestrator(userId: string): boolean {
  return callerOf(userId)?.role === "orchestrator";
}

/**
 * Reviewer выносит вердикт по сданной задаче и возвращает её в работу.
 *
 * Два пути попасть в ревьюеры:
 *   1. users.reviewer = 1 — узкий флаг, ставится владельцем вручную
 *      (auth.ts / seed.ts). Учётка Reviewer в живой базе имеет этот флаг.
 *   2. users.profile = 'reviewer' → роль Critic/Verifier по маппингу
 *      b6b57092. Альтернативный путь, завязанный на team_catalog.json;
 *      полезен, когда учётка заводится мимо seed.ts.
 *
 * Два пути нужны как страховка друг друга: если флаг потерян (а такое
 * бывало — миграция is_system_re reviewer в db.ts аддитивная, но флаг
 * ревьюера пришёл из ручной правки), profile-путь всё равно даст право.
 * Обратной проблемы нет: profile='reviewer' есть только у настоящей
 * учётки Reviewer, потому что маппинг закрыт именно этой строкой.
 */
export function isReviewer(userId: string): boolean {
  const c = callerOf(userId);
  if (c?.reviewer === 1) return true;
  return getRole(userId) === "Critic/Verifier";
}

/**
 * На кого записывать справочник (проект, метку), который заводит агент.
 *
 * Агент заводит их НЕ для себя: проект и метка — общий инструмент, ими
 * пользуются владелец и все его агенты. Записанные на агента, они для
 * остальных попросту не существуют — видимость ниже даёт агенту только
 * своё и принадлежащее владельцам.
 *
 * ⚠️ Прецедент 22.08.2026: проект «AI Control Center» завёл Claude_Bot, и
 * Гермес, получив задание по нему, не увидел проекта в своём списке вовсе
 * — решил, что задачи нет, и завёл её у себя во внутреннем кабане.
 *
 * Человек, работающий сам за себя, остаётся владельцем своих справочников:
 * правило касается только агентов (type='ai').
 */
export function ownerForNewShared(userId: string): string {
  if (callerOf(userId)?.type !== "ai") return userId;
  const owner = db
    .prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1")
    .get() as { id?: string } | undefined;
  return owner?.id ?? userId;
}

/**
 * Контур владельца: он сам и заведённые им агенты. Только внутри этого
 * круга действует «видно всё» — самостоятельно зарегистрированный человек
 * (role='agent', type='human') в него не входит и видит по-прежнему своё.
 */
export function seesEveryTask(userId: string): boolean {
  const c = callerOf(userId);
  return c?.role === "owner" ||
    c?.role === "orchestrator" ||
    c?.reviewer === 1 ||
    c?.type === "ai";
}

/**
 * Что видно вызывающему в списках справочников — проектов и меток.
 * Возвращает готовый кусок WHERE и параметры к нему, чтобы одно правило не
 * пришлось повторять в /api/projects, /api/labels и в поиске:
 *
 *   владелец      — всё;
 *   агент         — своё и принадлежащее владельцам трекера (решение
 *                   Максима 14.08.2026: «один человек и его же агенты,
 *                   стена между ними смысла не имеет»);
 *   прочий человек — только своё.
 *
 * `ownerColumn` подставляется в SQL как есть, поэтому вызывать её можно
 * только с литералом из кода («p.owner_id»), а не с чем-то из запроса.
 */
export function visibleScope(
  userId: string,
  ownerColumn: string,
): { sql: string; params: any[] } {
  const caller = callerOf(userId);
  if (caller?.role === "owner" || caller?.role === "orchestrator") {
    // Оркестратор распоряжается ЧУЖИМИ проектами, значит и в списке обязан
    // видеть все — иначе распорядиться нечем.
    return { sql: "1 = 1", params: [] };
  }
  if (caller?.type === "ai") {
    // Именно владельцы (role='owner'), а не «любой человек»: регистрация
    // открыта, и по «type != 'ai'» агент видел бы справочники случайного
    // зарегистрировавшегося человека — к работе это отношения не имеет.
    return {
      sql: `(${ownerColumn} = ? OR ${ownerColumn} IN (SELECT id FROM users WHERE role = 'owner'))`,
      params: [userId],
    };
  }
  return { sql: `${ownerColumn} = ?`, params: [userId] };
}

const taskById = () => db.prepare("SELECT * FROM tasks WHERE id = ?");

/**
 * Задача для ЧТЕНИЯ (карточка, подзадачи, лента, скачивание вложения).
 *
 * Владельцу и агентам — любая. Прочему человеку — прежнее правило владения,
 * включая «лежит в моём проекте»: без третьего условия владелец проекта
 * терял бы задачу, которую сам переназначил другому исполнителю (найдено
 * живьём 17.08.2026).
 */
export function getTaskForRead(
  taskId: string,
  userId: string,
): any | undefined {
  if (seesEveryTask(userId)) return taskById().get(taskId);
  return db
    .prepare(
      `SELECT * FROM tasks WHERE id = ? AND (
         creator_id = ? OR assignee_id = ? OR
         project_id IN (SELECT id FROM projects WHERE owner_id = ?)
       )`,
    )
    .get(taskId, userId, userId, userId);
}

/**
 * Задача для ПРАВКИ (поля, состояние работы, подзадачи, комментарии,
 * вложения).
 *
 * Владелец и оркестратор — любая. Агент — только своя: создал сам или
 * назначена ему. Это и есть «назначен не ты — туда не лезть»: чужая задача
 * агенту видна, но неизменяема.
 *
 * Оркестратор идёт здесь вместе с владельцем осознанно: переназначить
 * исполнителя, поправить формулировку и добавить шаг в ЧУЖУЮ задачу — это
 * и есть его работа (задача af2107b2). Удаления это ему не открывает:
 * DELETE отсекается в authOrApiToken до любого роута.
 */
export function getTaskForWrite(
  taskId: string,
  userId: string,
): any | undefined {
  if (isOwner(userId) || isOrchestrator(userId)) return taskById().get(taskId);

  const caller = callerOf(userId);
  if (caller?.type === "ai") {
    return db
      .prepare(
        "SELECT * FROM tasks WHERE id = ? AND (creator_id = ? OR assignee_id = ?)",
      )
      .get(taskId, userId, userId);
  }

  return db
    .prepare(
      `SELECT * FROM tasks WHERE id = ? AND (
         creator_id = ? OR assignee_id = ? OR
         project_id IN (SELECT id FROM projects WHERE owner_id = ?)
       )`,
    )
    .get(taskId, userId, userId, userId);
}

/**
 * Узкое право Reviewer: только сданная в review задача и только для
 * маршрута /state. Не использовать как общий доступ к правке задачи.
 */
export function getTaskForReview(
  taskId: string,
  userId: string,
): any | undefined {
  if (!isReviewer(userId)) return undefined;
  return db
    .prepare("SELECT * FROM tasks WHERE id = ? AND agent_state = 'review'")
    .get(taskId);
}

/**
 * Удаление задачи: владельцу — любая, остальным — только своя созданная
 * (исполнители сдают и закрывают, но не удаляют).
 */
export function getTaskForOwnerDelete(
  taskId: string,
  userId: string,
): any | undefined {
  if (isOwner(userId)) return taskById().get(taskId);
  return db
    .prepare("SELECT * FROM tasks WHERE id = ? AND creator_id = ?")
    .get(taskId, userId);
}

/**
 * Проект для УДАЛЕНИЯ: владельцу — любой, остальным — свой.
 *
 * Оркестратор сюда намеренно не добавлен: удалять он не вправе вовсе, и
 * пусть это видно и здесь, а не только в общей двери authOrApiToken.
 */
export function getProjectForUser(
  projectId: string,
  userId: string,
): any | undefined {
  if (isOwner(userId)) {
    return db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  }
  return db
    .prepare("SELECT * FROM projects WHERE id = ? AND owner_id = ?")
    .get(projectId, userId);
}

/** Проект для ПРАВКИ: то же самое плюс оркестратор, которому доступен любой. */
export function getProjectForWrite(
  projectId: string,
  userId: string,
): any | undefined {
  if (isOrchestrator(userId)) {
    return db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  }
  return getProjectForUser(projectId, userId);
}

/**
 * Проект, в который вызывающий вправе положить задачу.
 *
 * Обычный случай — свой проект (та же проверка, что и getProjectForUser).
 * Плюс один: агент (users.type = 'ai') может положить задачу в проект
 * человека, НО только когда задача этому же человеку и адресована
 * (assignee_id = projects.owner_id).
 *
 * С правилом по ролям (см. шапку файла) этот допуск перестал быть
 * единственным способом показать владельцу задачу агента — тот теперь видит
 * её в любом случае. Оставлен как есть: он работает, ничего не открывает
 * сверх прежнего и убирать его — отдельная работа.
 */
export function getProjectForFiling(
  projectId: string,
  userId: string,
  assigneeId: string | null | undefined,
): any | undefined {
  // Оркестратор кладёт задачу в любой существующий проект: он раздаёт
  // работу ботам по всей доске, а не ведёт свой угол.
  const forWrite = getProjectForWrite(projectId, userId);
  if (forWrite) return forWrite;

  const caller = callerOf(userId);
  if (caller?.type !== "ai") return undefined;

  if (assigneeId) {
    const forAssignee = db
      .prepare("SELECT * FROM projects WHERE id = ? AND owner_id = ?")
      .get(projectId, assigneeId);
    if (forAssignee) return forAssignee;
  }

  // И проект ВЛАДЕЛЬЦА системы — даже когда задача назначена на самого
  // агента. Иначе правило «задача агента обязана лежать в проекте, а не
  // висеть ничьей» невыполнимо: проекты заводит Максим, а задачи агент
  // берёт на себя. До 20.08.2026 это работало «само» — агент ходил в
  // трекер учёткой Максима через вход без пароля, то есть был им; когда
  // ту дверь закрыли (auth.ts, lanOwnerId), вскрылось, что своей учёткой
  // агент подшить задачу в проект не может вовсе.
  //
  // Шире это ничего не открывает: владелец в системе один, чужих людей
  // с проектами тут нет, а видеть все задачи агент и так вправе.
  return db
    .prepare(
      `SELECT p.* FROM projects p
         JOIN users u ON u.id = p.owner_id
        WHERE p.id = ? AND u.role = 'owner'`,
    )
    .get(projectId);
}

/** Метка для правки/удаления: владельцу — любая, остальным — своя. */
export function getLabelForUser(
  labelId: string,
  userId: string,
): any | undefined {
  if (isOwner(userId)) {
    return db.prepare("SELECT * FROM labels WHERE id = ?").get(labelId);
  }
  return db
    .prepare("SELECT * FROM labels WHERE id = ? AND owner_id = ?")
    .get(labelId, userId);
}

/**
 * True, если каждой меткой из `labelIds` вызывающий вправе пометить задачу.
 *
 * Владельцу доступны любые. Агенту — свои и метки владельца трекера: он
 * ставит задаче метку владельца, а не заводит собственную
 * (симметрично проектам, решение Максима 14.08.2026 — «один человек и его
 * же агенты, стена между ними смысла не имеет»). Прочему человеку — только
 * свои.
 */
export function allLabelsOwnedByUser(
  labelIds: string[],
  userId: string,
): boolean {
  const unique = [...new Set(labelIds)];
  if (unique.length === 0) return true;
  const placeholders = unique.map(() => "?").join(",");

  if (isOwner(userId)) {
    const known = db
      .prepare(`SELECT id FROM labels WHERE id IN (${placeholders})`)
      .all(...unique) as Array<{ id: string }>;
    return known.length === unique.length;
  }

  if (callerOf(userId)?.type === "ai") {
    const usable = db
      .prepare(
        `SELECT l.id FROM labels l
           JOIN users u ON u.id = l.owner_id
          WHERE l.id IN (${placeholders}) AND (l.owner_id = ? OR u.role = 'owner')`,
      )
      .all(...unique, userId) as Array<{ id: string }>;
    return usable.length === unique.length;
  }

  const owned = db
    .prepare(
      `SELECT id FROM labels WHERE owner_id = ? AND id IN (${placeholders})`,
    )
    .all(userId, ...unique) as Array<{ id: string }>;
  return owned.length === unique.length;
}
