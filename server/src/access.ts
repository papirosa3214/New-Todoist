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
 *
 * Исторические имена (claude_bot, hermes, antigravity, pi_agent,
 * deepseek) с 05.10.2026 из маппинга убраны: pi_agent заархивирован
 * миграцией 040, остальные — сухие остатки старых shell-имён (см.
 * SHELL_AGENT_IDS в roleRouting.ts). Если завтра кто-то вернёт
 * `pi_agent` в team_catalog.json, getRole вернёт null и авторизация по
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

/** Владелец трекера — карт-бланш на чтение и на правку. */
export function isOwner(userId: string): boolean {
  return callerOf(userId)?.role === "owner";
}

/**
 * Оркестратор — живая роль диспетчера/контролёра (L4, см. шапку файла).
 *
 * Распорядитель работы ботов. Читает и правит что угодно наравне с
 * владельцем, но не удаляет ничего: он раздаёт и переставляет работу, а
 * решение «этого больше не нужно» остаётся за человеком. Отказ
 * выдаётся раньше роутов — в authOrApiToken (auth.ts), на любой DELETE.
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
  if (isOwner(userId) || isOrchestrator(userId)) return row;

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
  const row = db
    .prepare("SELECT * FROM tasks WHERE id = ? AND agent_state = 'review'")
    .get(taskId);
  if (!row) return undefined;
  // Приватный проект (задача 9d583c58…): ревьюер — не владелец, задачу
  // приватного проекта он выносить не должен.
  if (projectHiddenFrom(userId, getProjectRow((row as any).project_id))) {
    return undefined;
  }
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
  if (isOwner(userId)) return row;
  return db
    .prepare("SELECT * FROM tasks WHERE id = ? AND creator_id = ?")
    .get(taskId, userId);
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

/** Commentary is narrower than editing a card: an assigned approved slot may report its work. */
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
  return db.prepare(`SELECT t.* FROM tasks t WHERE t.id=? AND EXISTS (
    SELECT 1 FROM subtasks s JOIN task_collaboration_plans p ON p.id=s.collaboration_plan_id
    WHERE s.task_id=t.id AND s.agent_id=? AND s.done=0 AND p.status='approved'
  )`).get(taskId,userId);
}
