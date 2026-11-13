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
//                 — оркестратор: ЖИВАЯ роль диспетчера/контролёра (L4).
//                   Учётка «Оркестратор Claude», одна в системе. Читает и
//                   правит любые проекты и задачи, назначает исполнителей,
//                   заводит подзадачи, утверждает планы, сидит в чатах
//                   задач — как владелец, но БЕЗ права удаления (задача
//                   af2107b2, 28.08.2026). Запрет на удаление стоит одной
//                   дверью в authOrApiToken (auth.ts) и накрывает все
//                   DELETE разом; поэтому здесь, в access.ts, оркестратору
//                   расширены только чтение и правка, а функции поиска
//                   «что можно удалять» ему не открываются.
//
//                   Это НЕ автономный оркестратор, отменённый 08.09.2026:
//                   того в живом коде больше нет, а комментарии и старые
//                   примечания ещё попадаются — при чтении `access.ts` это
//                   видно сразу и путаницы не возникает.
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
import { isServiceUser } from "./serviceUser.js";

type Caller = { id?: string; role?: string; role_key?: string | null; type?: string; reviewer?: number; profile?: string | null; permissions?: string | null };

function callerOf(userId: string): Caller | undefined {
  return db.prepare("SELECT id, role, role_key, type, reviewer, profile, permissions FROM users WHERE id = ?").get(userId) as
    Caller | undefined;
}

/** «Агентоподобный» вызывающий: настоящий агент (type='ai') или служебная
 *  учётка «Система» — серверная автоматика планировщика. У них одни правила
 *  видимости: видит всё, меняет только своё или назначенное. С 06.10.2026
 *  (MAK-72) служебная учётка — «Система» (role='service', type='human'),
 *  но по правам она — продолжение прежней агентской служебной учётки. */
function isAiCaller(caller: Caller | undefined): boolean {
  return caller?.type === "ai" || (caller?.id ? isServiceUser(caller.id) : false);
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
 *
 * Исторические имена старых shell-учёток (06.10.2026, MAK-72) из
 * маппинга убраны вместе с самими учётками. Если завтра кто-то вернёт
 * любое из них в team_catalog.json, getRole вернёт null и авторизация по
 * профилю работать не будет — это и есть защита: добавить профиль без
 * явного решения владельца.
 */
const PROFILE_ROLE: Record<string, string> = {
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

/** Помощник владельца — отдельная ai-учётка с постоянным role_key. */
export function isSecretary(userId: string): boolean {
  const caller = callerOf(userId);
  return caller?.type === "ai" && (caller.role_key === "secretary" || caller.id === "u-secretary");
}

/** Владелец трекера и его Помощник — карт-бланш на чтение и правку.
 * Удаление для Помощника отдельно блокирует общая дверь authOrApiToken. */
export function isOwner(userId: string): boolean {
  return callerOf(userId)?.role === "owner" || isSecretary(userId);
}

/**
 * Текст писателя-роли (агента трекера, type='ai').
 *
 * Нужен гейту формата ответов (карточка cea8d997): нормализация и автозамена
 * существуют ради ролей, а не ради человека. Владелец пишет в чат, в
 * описания и комментарии сам, и молча переписанная его таблица — потеря его
 * слов; ровно поэтому гейт в /api/chats/:id/messages смотрит на отправителя.
 */
export function isRoleAuthor(userId: string): boolean {
  return callerOf(userId)?.type === "ai";
}

/**
 * Учётка «Оркестратор Claude» (users.role = 'orchestrator') — внешний агент
 * для отладки. Владелец 13.11.2026 дал ей доступ к сессиям владельца
 * (/api/sessions): читать и писать в них, чтобы проверять работу Помощника.
 * Только эта учётка: Помощник и роли с правом orchestrate сюда не входят.
 */
export function isSessionAgent(userId: string): boolean {
  return callerOf(userId)?.role === "orchestrator";
}

/**
 * Делегированный доступ без удаления: живой оркестратор и Помощник владельца.
 * Оба управляют задачами наравне с владельцем; DELETE закрывается общей
 * дверью authOrApiToken (auth.ts). Секретарь распознаётся по role_key, а
 * фиксированная legacy-учётка u-secretary остаётся совместимой.
 */
export function isOrchestrator(userId: string): boolean {
  const caller = callerOf(userId);
  if (caller?.role === "orchestrator") return true;
  if (isSecretary(userId)) return true;
  if (caller?.role !== "agent" || caller.type !== "ai") return false;
  try { return JSON.parse(caller.permissions ?? "{}").orchestrate === true; }
  catch { return false; }
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
 * ⚠️ Прецедент 22.08.2026: агент завёл общий проект на своём аккаунте, и
 * второй агент, получив задание по нему, не увидел проекта в своём списке вовсе
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
    isAiCaller(c);
}

/**
 * Скрывает ли приватный проект (или задачу в приватном проекте) от
 * вызывающего. Правило задачи 9d583c58…: «приватный проект и его задачи
 * не отдаются через API никому, кроме владельца». Здесь «владелец» —
 * `users.role = 'owner'` (в системе он один, u1); оркестратор, агенты и
 * прочие люди идут в один круг «скрыто».
 *
 * Принимает уже прочитанную строку проекта, чтобы на одну проверку не
 * гонять два SELECT (задача + проект): вызывающие достают проект ровно
 * для этой строки задачи, и дополнительный поход в базу был бы лишним.
 * Пустая строка / undefined / `is_private != 1` — `false`, не скрывает.
 */
export function privateProjectHides(
  userId: string,
  project: { is_private?: number | null } | null | undefined,
): boolean {
  if (!project) return false;
  if ((project.is_private ?? 0) !== 1) return false;
  // Скрыто от всех, кроме самого владельца трекера. Оркестратор и агенты —
  // не владелец, поэтому у них `seesEveryTask` истина, а видеть приватное
  // всё равно нельзя: это и есть «закрытое» в задаче, никаких слоёв к
  // этому правилу не добавляется.
  return !isOwner(userId);
}

/**
 * Скрывает ли архивный проект (или задачу в архивном проекте) от
 * вызывающего (карточка a1be7d63…). Правило владельца 06.10.2026: удаление
 * проекта не уничтожает данные, а переносит проект вместе со всем
 * содержимым в Архив. В обычных местах архивное не фигурирует НИ У КОГО,
 * включая владельца: списки, поиск, лента, чаты, уведомления и планы
 * фильтруются SQL-условием (`visibleProjectScope`, `archivedProjectHides`
 * используется только на прямых запросах по id).
 *
 * Прямой запрос по id архивного проекта/задачи владельцу читается — ему
 * нужен экран Архива и ручки restore/purge. Всем прочим — нет.
 *
 * Принимает уже прочитанную строку проекта (как `privateProjectHides`),
 * чтобы не гонять лишний SELECT.
 */
export function archivedProjectHides(
  userId: string,
  project: { archived_at?: string | null } | null | undefined,
): boolean {
  if (!project) return false;
  if (!project.archived_at) return false;
  return !isOwner(userId);
}

/**
 * Прочитать проект по id. Возвращает строку проекта или undefined, если
 * его нет. Используется в воротах, чтобы не дублировать SELECT в каждом
 * чтении задачи — задача приходит первой, проект за ней одним запросом.
 */
function getProjectRow(projectId: string | null | undefined): any | undefined {
  if (!projectId) return undefined;
  return db
    .prepare("SELECT is_private, archived_at FROM projects WHERE id = ?")
    .get(projectId);
}

/**
 * Дополнительные признаки задачи, нужные воротам для одной строки:
 * архивный статус. Читается отдельным SELECT перед getTaskFor*, чтобы
 * ворота могли отсечь архивную карточку от постороннего тем же
 * «undefined», что и приватный/архивный проект.
 */
function getTaskArchivedFlag(
  taskId: string,
): string | null | undefined {
  const row = db
    .prepare("SELECT archived_at FROM tasks WHERE id = ?")
    .get(taskId);
  return row ? (row as { archived_at?: string | null }).archived_at : undefined;
}

/**
 * Проект скрыт от вызывающего по любому из признаков: приватный
 * (`privateProjectHides`, задача 9d583c58…) или архивный
 * (`archivedProjectHides`, карточка a1be7d63…). Единая точка для прямых
 * запросов по id: обе причины возвращают `undefined`, чтобы вызывающий
 * ответил 404 без раскрытия факта существования.
 */
function projectHiddenFrom(userId: string, project: any): boolean {
  return (
    privateProjectHides(userId, project) ||
    archivedProjectHides(userId, project)
  );
}

/**
 * Скрывает ли архивная задача от вызывающего (карточка 57c69735…).
 *
 * Зеркало `archivedProjectHides`: архивная задача не фигурирует нигде,
 * кроме прямого запроса владельца (экрану Архива нужны restore/purge).
 * Всем прочим — 404, как если бы карточки не было.
 *
 * Принимает уже прочитанную строку задачи, чтобы не гонять второй SELECT:
 * вызывающие и так её читают для остальных проверок (getProjectRow идёт
 * следом, и здесь — две строки на одну задачу). Это та же техника, что и
 * у `privateProjectHides`/`archivedProjectHides` для проекта.
 */
function archivedTaskHides(
  userId: string,
  task: { archived_at?: string | null } | null | undefined,
): boolean {
  if (!task) return false;
  if (!task.archived_at) return false;
  return !isOwner(userId);
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
  if (isAiCaller(caller)) {
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

/**
 * Видимость проектов с учётом приватности (задача 9d583c58…): то же
 * правило, что и `visibleScope`, плюс «приватный проект виден только
 * владельцу трекера». `ownerColumn` — `p.owner_id` литералом (то же
 * требование, что и у `visibleScope`).
 */
export function visibleProjectScope(
  userId: string,
  ownerColumn: string,
): { sql: string; params: any[] } {
  const caller = callerOf(userId);
  if (caller?.role === "owner") {
    // Владельцу в обычных списках архив не показываем: для него есть
    // отдельный экран Архива и ручки /api/projects/archive. Фильтр
    // `archived_at IS NULL` применяется и к владельцу.
    return { sql: "archived_at IS NULL", params: [] };
  }
  const privacyClause = "(is_private = 0 OR is_private IS NULL) AND archived_at IS NULL";
  if (caller?.role === "orchestrator") {
    return { sql: privacyClause, params: [] };
  }
  if (caller?.type === "ai") {
    return {
      sql: `${privacyClause} AND (${ownerColumn} = ? OR ${ownerColumn} IN (SELECT id FROM users WHERE role = 'owner'))`,
      params: [userId],
    };
  }
  return { sql: `${privacyClause} AND ${ownerColumn} = ?`, params: [userId] };
}

const taskById = () => db.prepare("SELECT * FROM tasks WHERE id = ?");

/**
 * Задача для ЧТЕНИЯ (карточка, подзадачи, лента, скачивание вложения).
 *
 * Владельцу и агентам — любая. Прочему человеку — прежнее правило владения,
 * включая «лежит в моём проекте»: без третьего условия владелец проекта
 * терял бы задачу, которую сам переназначил другому исполнителю (найдено
 * живьём 17.08.2026).
 *
 * Приватный проект: даже у оркестратора и у агента прочитать задачу
 * нельзя — это и есть «не отдавать через API никому, кроме владельца»
 * (задача 9d583c58…). Возвращаем `undefined` ровно так же, как на
 * «не существует», чтобы вызывающий ответил 404 без раскрытия факта
 * существования. Проверка стоит ДО «видит всё»: иначе приватность
 * работала бы только для прочих людей.
 */
export function getTaskForRead(
  taskId: string,
  userId: string,
): any | undefined {
  const row = taskById().get(taskId);
  if (!row) return undefined;
  if (projectHiddenFrom(userId, getProjectRow((row as any).project_id))) {
    return undefined;
  }
  // Архивная задача (карточка 57c69735…): прячем от всех, кроме владельца.
  // Владельцу нужен экран Архива и ручки restore/purge — для него это
  // исключение. Стоит ДО «видит всё», иначе прочие пользователи читали
  // бы архивную чужую задачу по видимости «agent видит всё».
  if (archivedTaskHides(userId, row as any)) return undefined;
  if (seesEveryTask(userId)) return row;
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
 *
 * Приватный проект: даже оркестратор сюда не заходит (задача 9d583c58…):
 * «не отдавать через API никому, кроме владельца». Владелец трекера — одна
 * учётка, и она же проходит первой проверкой ниже.
 */
export function getTaskForWrite(
  taskId: string,
  userId: string,
): any | undefined {
  const row = taskById().get(taskId);
  if (!row) return undefined;
  if (projectHiddenFrom(userId, getProjectRow((row as any).project_id))) {
    return undefined;
  }
  // Карточка 57c69735…: даже оркестратору/агенту не править архивную
  // чужую задачу — пишущему пользователю мы отдаём 404 как на «не
  // существует» (а не 403 на «существует, но нельзя»), потому что иначе
  // существование архивной чужой задачи утекает по факту ответа.
  if (archivedTaskHides(userId, row as any)) return undefined;
  if (isOwner(userId) || isOrchestrator(userId)) return row;

  const caller = callerOf(userId);
  if (isAiCaller(caller)) {
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
  const row = db
    .prepare("SELECT * FROM tasks WHERE id = ? AND agent_state = 'review'")
    .get(taskId);
  if (!row) return undefined;
  // Приватный проект (задача 9d583c58…): ревьюер — не владелец, задачу
  // приватного проекта он выносить не должен.
  if (projectHiddenFrom(userId, getProjectRow((row as any).project_id))) {
    return undefined;
  }
  // Архивная задача (карточка 57c69735…): ревьюеру нечего ревьюировать —
  // работа снята при архивировании, шаги плана не возобновляются.
  if (archivedTaskHides(userId, row as any)) return undefined;
  return row;
}

/**
 * Удаление задачи: владельцу — любая, остальным — только своя созданная
 * (исполнители сдают и закрывают, но не удаляют).
 */
export function getTaskForOwnerDelete(
  taskId: string,
  userId: string,
): any | undefined {
  const row = taskById().get(taskId);
  if (!row) return undefined;
  // Приватный проект (задача 9d583c58…): только владелец трекера. Иначе
  // агент-создатель по старому `creator_id = ?` вернул бы 200/404 и
  // подтвердил существование скрытой задачи.
  if (projectHiddenFrom(userId, getProjectRow((row as any).project_id))) {
    return undefined;
  }
  // Карточка 57c69735…: эта функция — единая точка для архивирования и
  // purge. Архивная карточка видна владельцу и создателю (для
  // идемпотентного archive). Чужой человек (не владелец, не создатель)
  // идёт в `undefined` — роут ниже превращает это в 403/404 согласно
  // контракту. Сам факт «архивная» из этой функции наружу не утекает:
  // поведение «живая+чужая» и «архивная+чужая» для постороннего
  // одинаковы, чтобы существование чужой архивной карточки не
  // подтверждалось.
  if (isOwner(userId)) return row;
  if ((row as { creator_id: string }).creator_id === userId) return row;
  return undefined;
}

/**
 * Проект для УДАЛЕНИЯ: владельцу — любой, остальным — свой.
 *
 * Оркестратор сюда не добавлен: удалять он не вправе вовсе, и общий
 * запрет enforce'ится в authOrApiToken (auth.ts, deleteForbidden) — он
 * накрывает все DELETE разом, а проверять в каждом дочернем месте
 * отдельно значит держать два слоя одного правила. Владелец 05.10.2026:
 * «правило в одном месте».
 *
 * Приватный проект (задача 9d583c58…): виден только владельцу трекера.
 * Через `getProjectForUser` идут удаление, прямой PATCH (если бы он
 * не был под `getProjectForWrite`) и любой SELECT по id. Возвращаем
 * `undefined` — вызывающий отвечает 404 без раскрытия факта
 * существования приватного проекта.
 */
export function getProjectForUser(
  projectId: string,
  userId: string,
): any | undefined {
  if (isOwner(userId)) {
    return db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  }
  // Приватный проект не виден никому, кроме владельца — даже тому, кто
  // числится `owner_id` строки (это может быть любой человек, а не
  // `users.role='owner'`). Прячем всю строку. Архивный проект (карточка
  // a1be7d63…) тоже не отдаётся никому, кроме владельца: обычные списки и
  // прямой запрос по id к нему закрыты.
  return db
    .prepare(
      `SELECT * FROM projects WHERE id = ? AND owner_id = ?
         AND (is_private = 0 OR is_private IS NULL)
         AND archived_at IS NULL`,
    )
    .get(projectId, userId);
}

/** Проект для ПРАВКИ: то же самое плюс оркестратор, которому доступен любой. */
export function getProjectForWrite(
  projectId: string,
  userId: string,
): any | undefined {
  if (isOrchestrator(userId)) {
    // Оркестратор видит любой проект, кроме приватного (задача 9d583c58…:
    // «не отдавать через API никому, кроме владельца»). Удалять он всё
    // равно не вправе — см. шапку getProjectForUser.
    return db
      .prepare(
        `SELECT * FROM projects WHERE id = ?
           AND (is_private = 0 OR is_private IS NULL)
           AND archived_at IS NULL`,
      )
      .get(projectId);
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

  // Приватный проект (задача 9d583c58…): агенту класть в него задачу
  // нельзя ни при каких условиях — иначе «не отдавать через API никому,
  // кроме владельца» нарушалось бы ещё на этапе создания. Сразу `undefined`,
  // вызывающий ответит 400 «invalid project_id».
  const meta = db
    .prepare("SELECT is_private, archived_at FROM projects WHERE id = ?")
    .get(projectId) as
    | { is_private?: number | null; archived_at?: string | null }
    | undefined;
  if (meta?.is_private === 1) return undefined;
  // Архивный проект (карточка a1be7d63…): положить в него задачу нельзя —
  // в обычных местах он не фигурирует, а новые задачи в архиве не заводят.
  if (meta?.archived_at) return undefined;

  if (assigneeId) {
    const forAssignee = db
      .prepare(
        "SELECT * FROM projects WHERE id = ? AND owner_id = ? AND archived_at IS NULL",
      )
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
        WHERE p.id = ? AND u.role = 'owner' AND p.archived_at IS NULL`,
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

  if (isAiCaller(callerOf(userId))) {
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

/** Commentary is narrower than editing a card: an assigned approved slot may report its work. */
/** Почему комментарий не принят. Людям — прежний 404 (не выдаём, что
 *  карточка существует). ИИ-роли по карточке, которую ей видеть можно,
 *  получают причину и следующий шаг: голый «Not found» они читали как
 *  «у меня нет доступа» и жаловались владельцу (19.10.2026). */
export function commentRefusal(taskId:string,userId:string):{status:number;error:string} {
  const notFound = { status: 404, error: "Not found" };
  if (callerOf(userId)?.type !== "ai") return notFound;
  const row = taskById().get(taskId) as any;
  if (!row || projectHiddenFrom(userId, getProjectRow(row.project_id))) return notFound;
  if (row.archived_at) return { status: 409, error: "Карточка в архиве — комментарии к ней не принимаются. Если работа продолжается, напиши владельцу в чат." };
  return {
    status: 403,
    error: "Комментировать карточку может только её исполнитель или роль с открытым шагом в утверждённом плане этой карточки. "
      + "У тебя здесь открытого шага нет (или он уже сдан). Дальше: 1) если работаешь в своём шаге — пиши в карточку этого шага (taskflow_my_tasks покажет её id); "
      + "2) если нужно сообщить участнику — taskflow_topic_send или чат с владельцем; 3) отчёт сохраняй через taskflow_doc_write.",
  };
}

/** 404 по карточке или шагу. Людям — прежний «Not found». ИИ-роли объясняем
 *  частые путаницы: id карточки вместо id шага и наоборот, удалённая карточка,
 *  чужая карточка (разбор отказов 19.10.2026). Скрытое роли не раскрываем:
 *  о найденной записи говорим, только если роль может её читать. */
export function aiNotFound(id:string,expected:"task"|"subtask",userId:string):{status:number;error:string} {
  const notFound = { status: 404, error: "Not found" };
  if (callerOf(userId)?.type !== "ai") return notFound;
  const fresh = " Актуальные карточки и шаги — taskflow_my_tasks.";
  const task = getTaskForRead(id, userId) as any;
  const step = db.prepare("SELECT id, task_id, title FROM subtasks WHERE id = ?").get(id) as { id: string; task_id: string; title: string } | undefined;
  const stepVisible = step && getTaskForRead(step.task_id, userId);
  if (expected === "subtask") {
    if (task) {
      const steps = db.prepare("SELECT id, title FROM subtasks WHERE task_id = ? AND done = 0 ORDER BY position LIMIT 8").all(id) as Array<{ id: string; title: string }>;
      const list = steps.length ? ` Открытые шаги этой карточки: ${steps.map((x) => `${x.id} «${x.title.slice(0, 60)}»`).join("; ")}.` : " Открытых шагов у этой карточки нет.";
      return { status: 404, error: `Это id карточки, а не шага.${list} Повтори с id шага.` };
    }
    if (stepVisible) return { status: 403, error: "Этот шаг закреплён не за тобой — сдавать и менять его может только его исполнитель." + fresh };
    return { status: 404, error: "Шага с таким id нет — он удалён или id неверный." + fresh };
  }
  if (task) return { status: 403, error: "Карточка есть, но её состояние меняет исполнитель, а ты им не являешься. Работай в своём шаге: taskflow_subtask_work / taskflow_subtask_done." + fresh };
  if (stepVisible) return { status: 404, error: `Это id шага, а не карточки; его карточка — ${step!.task_id}. Состояние шага меняют taskflow_subtask_work и taskflow_subtask_done.` };
  return { status: 404, error: "Карточки с таким id нет — она удалена или id неверный. Не повторяй вызов." + fresh };
}

export function getTaskForComment(taskId:string,userId:string):any|undefined {
  const viaWrite = getTaskForWrite(taskId,userId);
  if (viaWrite) return viaWrite;
  // Даже при наличии «утверждённого слота» комментарий к приватной задаче
  // — утечка: исполнитель слота агент, а приватный проект агенту закрыт.
  // Режем сразу, иначе вторая ветка ниже отдала бы строку.
  const row = taskById().get(taskId);
  if (!row) return undefined;
  if (projectHiddenFrom(userId, getProjectRow((row as any).project_id))) {
    return undefined;
  }
  // Карточка 57c69735…: комментарии к архивной задаче не пишут — работа
  // снята, активности нет, обсуждать нечего. Владельцу на экране Архива
  // это тоже не нужно: restore или purge делаются явным действием.
  if (archivedTaskHides(userId, row as any)) return undefined;
  return db.prepare(`SELECT t.* FROM tasks t WHERE t.id=? AND EXISTS (
    SELECT 1 FROM subtasks s JOIN task_collaboration_plans p ON p.id=s.collaboration_plan_id
    WHERE s.task_id=t.id AND s.agent_id=? AND s.done=0 AND p.status='approved'
  )`).get(taskId,userId);
}
