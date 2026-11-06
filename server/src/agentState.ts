// Core of the agent-work protocol (see AGENT-PROTOCOL.md). Everything about
// "what state can follow what, who's allowed to cause it, and is the lease
// still alive" lives in this one file — routes/agent-state.ts and
// routes/tasks.ts only call into it, they never re-derive the rules.
import { registryTextOr } from "./lib/roleRules.js";
import { queueOrchestratorEvent } from "./lib/orchestratorWebhook.js";
import crypto from "crypto";
import db from "./db.js";

// Срок аренды: сколько задача считается «в работе» после последнего сигнала
// агента. Было 15 минут, с 14.08.2026 — 5 (решение Максима): пропавшего
// исполнителя надо видеть быстро, а не через четверть часа.
export const LEASE_MINUTES = 5;

export type AgentState = "in_progress" | "blocked" | "review";
export const AGENT_STATES: AgentState[] = ["in_progress", "blocked", "review"];

const uid = () => crypto.randomUUID();

/**
 * `tasks.agent_heartbeat_at` (like every other timestamp column in this
 * schema — created_at, updated_at, completed_at) is written with SQLite's
 * `datetime('now')`, which is UTC but formatted as "YYYY-MM-DD HH:MM:SS" —
 * no "Z", no "T". `new Date(that string)` parses it as LOCAL time in
 * Node, which silently shifts every heartbeat by the server's UTC offset.
 * On a UTC+3 box a fresh heartbeat would look 3 hours old and
 * `agent_stale` would be permanently (wrongly) true. Normalize to a
 * real ISO-8601 UTC string before handing it to `Date`.
 */
function parseSqliteUtc(value: string): Date {
  return new Date(value.replace(" ", "T") + "Z");
}

/** Lease expiry = last heartbeat + LEASE_MINUTES. */
export function leaseExpiresAt(
  heartbeatAt: string | null | undefined,
): Date | null {
  if (!heartbeatAt) return null;
  return new Date(
    parseSqliteUtc(heartbeatAt).getTime() + LEASE_MINUTES * 60_000,
  );
}

/** True if the lease taken out at `heartbeatAt` has expired ("агент пропал"). */
export function isStale(heartbeatAt: string | null | undefined): boolean {
  const expires = leaseExpiresAt(heartbeatAt);
  if (!expires) return false;
  return expires.getTime() <= Date.now();
}

type Caller = {
  isOwner: boolean;
  isExecutor: boolean;
  isReviewer?: boolean;
  // Reviewer-first: карточку после сдачи смотрит Reviewer, и исполнитель не
  // может сам снять её из review — только Reviewer или владелец. См.
  // canTransition, строка review -> in_progress.
  requiresReviewerReview?: boolean;
  // Only meaningful for the from==='in_progress' rows: whether the lease
  // has expired. Drives the in_progress -> in_progress self-reclaim row —
  // see canTransition below.
  leaseExpired?: boolean;
};

/** Which endpoint is asking. claim() and state() share most of the matrix
 * but diverge on two rows — see canTransition. */
export type TransitionVia = "claim" | "state";

/**
 * Transition matrix (AGENT-PROTOCOL.md, "Матрица переходов"). `completed`
 * is deliberately NOT modeled here — that leg of the state machine lives in
 * `status` (PATCH /api/tasks/:id), not `agent_state`; see
 * AGENT-PROTOCOL.md "Решение о хранении". This function covers the four
 * `agent_state` values both POST /api/tasks/:id/state and
 * POST /api/tasks/:id/claim are allowed to reach: null | in_progress |
 * blocked | review. **claim() must call this too** — it is not a
 * shortcut around the matrix, just a second door onto some of the same
 * rows (AGENT-PROTOCOL.md, "claim подчиняется той же матрице").
 *
 * A caller can hold both roles at once (creator claims their own task) —
 * so `who` is a set of held roles, not a single exclusive one, and a
 * transition is allowed if ANY held role permits it.
 *
 * Two rows are endpoint-specific:
 *  - `in_progress -> in_progress` (self-reclaim of an expired lease) only
 *    claim() can take — state() has no reason to request a no-op transition.
 *  - `review -> in_progress` only state() can take, with a mandatory comment
 *    (see commentRequiredFor). Владелец и Reviewer снимают карточку из `review`; исполнитель — только
 *    если у карточки НЕ включён reviewer-first (`who.requiresReviewerReview`).
 *    claim() still cannot reach into `review`: silently resuming a task the
 *    owner is looking at would hide the transition from the feed, and the
 *    mandatory comment is the point.
 */
export function canTransition(
  from: AgentState | null,
  to: AgentState | null,
  who: Caller,
  via: TransitionVia,
): boolean {
  if (from === null && to === "in_progress") return who.isExecutor;
  if (from === "blocked" && to === "in_progress") return who.isExecutor;
  if (from === "in_progress" && to === "review") return who.isExecutor;
  if (from === "in_progress" && to === "blocked") return who.isExecutor;
  if (from === "in_progress" && to === "in_progress") {
    return via === "claim" && who.isExecutor && !!who.leaseExpired;
  }
  if (from === "review" && to === "in_progress") {
    if (via !== "state") return false;
    // Владелец — вне процесса: снимает карточку из review всегда.
    if (who.isOwner) return true;
    // Reviewer снимает сданную работу на доработку.
    if (who.isReviewer) return true;
    // Исполнитель возвращает сам только не-reviewer-first карточку; у
    // reviewer-first снять работу может лишь Reviewer/владелец.
    return !!who.isExecutor && !who.requiresReviewerReview;
  }
  // "любое → NULL, владелец, снять с агента"
  if (to === null) return who.isOwner;
  return false;
}

/** Текст отказа вместо голого «invalid transition»: откуда, куда нельзя, куда
 *  можно этому вызывающему и что делать (разбор отказов ролей 19.10.2026). */
export function transitionRefusal(
  from: AgentState | null,
  to: AgentState | null,
  who: Caller,
  via: TransitionVia,
): string {
  const name = (s: AgentState | null) => s ?? "свободна";
  const allowed = (["in_progress", "blocked", "review", null] as Array<AgentState | null>)
    .filter((t) => t !== from && canTransition(from, t, who, via))
    .map(name);
  const head = `Переход «${name(from)}» → «${name(to)}» тебе не разрешён.`;
  const can = allowed.length ? ` Отсюда тебе можно: ${allowed.join(", ")}.` : " Отсюда тебе сейчас никуда нельзя.";
  const why = !who.isExecutor && !who.isOwner && !who.isReviewer
    ? " Ты не исполнитель этой карточки: работай в своём шаге (taskflow_my_tasks), а состояние карточки меняет её исполнитель или сервер."
    : from === "review"
      ? " Карточка на проверке — вернуть её в работу может владелец или проверяющий."
      : to === "review" || to === "blocked"
        ? " В review и blocked переводят из in_progress: сначала возьми задачу в работу."
        : "";
  return head + can + why + " Тот же вызов без изменений не повторяй.";
}

/**
 * Comment is mandatory not just by destination state but by the (from, to)
 * pair (AGENT-PROTOCOL.md, "Что нельзя сделать молча" + the `review ->
 * in_progress` row's "комментарий обязателен"): blocked/review always need
 * one, and so does an owner sending work from `review` back to
 * `in_progress` — the agent has to be told what's wrong, or it just
 * re-reads "in_progress" with no idea what to fix.
 */
export function commentRequiredFor(
  from: AgentState | null,
  to: AgentState | null,
): boolean {
  if (to === "blocked" || to === "review") return true;
  if (from === "review" && to === "in_progress") return true;
  return false;
}

/**
 * ПРАВИЛА, КОТОРЫЕ ВЫДАЮТСЯ АГЕНТУ В МОМЕНТ ВЗЯТИЯ РАБОТЫ.
 *
 * Максим 20.08.2026: «напиши это правилом, чтобы всё было сразу указано —
 * чтобы любой агент, ты или не ты, когда приступает к работе в рамках этой
 * задачи, на него сразу же всё это навешивалось, и он строго соблюдал».
 *
 * Поэтому текст возвращается сервером в ответе на claim и на взятие шага:
 * агент получает его до того, как что-то напишет, и не зависит от того,
 * читал ли он чей-то CLAUDE.md.
 *
 * Сами формулировки — из его же комментариев к возвращённым шагам:
 *  • «Задача — это суть проблемы. Подзадачи — это шаги решения этой
 *    проблемы. „Единая левая кромка“ — это не решение проблемы»;
 *  • «пишем коротко суть… по-человечески, в одно-два предложения, просто
 *    итоговое решение этой проблемы для оценки фактического выполнения:
 *    ни больше, ни меньше. Не нужно технических деталей… этот отчёт должен
 *    быть лёгким и понятным, чтобы не приходилось сидеть и разбираться»;
 *  • «неужели нужно было дублировать информацию из аудита, а не написать,
 *    с какой проблемой мы столкнулись в рамках этой задачи?».
 */
const AGENT_RULES_LITERAL = [
  "РЕЖИМ КАРТОЧКИ. Это правила работы по карточке; в чате они не действуют. Прочитай карточку через taskflow_task. Прежде чем работать — taskflow_claim или taskflow_heartbeat, чтобы не пересечься с другой ролью. В слоте работай молча: инструменты, чек-лист, итог при сдаче. Результат сдаёшь через taskflow_subtask_done (шаг) или taskflow_report.",
  "Статус шага живой: перед началом — in_progress; сделал — закрываешь done сам, с result. Упёрся и нужно решение владельца — blocked с причиной и конкретным вопросом (инструмента вопроса владельцу в карточке нет). Мелочь, которую можешь решить на своём уровне, решай сам или спроси Оркестратора. Ждёшь другую роль, а не владельца — оставайся in_progress.",
  "Упёрся (blocked) — приложи снимок работы к taskflow_subtask_work(state=\"blocked\") или вызови taskflow_slot_snapshot: что сделано (done), что осталось (left), блок (blocker), следующий шаг (next_step), артефакты. Пока работаешь, технический снимок сервер пишет сам. Снимок — запись, а не команда: прав и статусов он не даёт.",
  "result шага — одно-два предложения по-человечески: что в итоге сделано, чтобы владелец мог оценить факт выполнения. Технические детали, числа и выдержки из аудита в карточку не переносить — им место в базе знаний.",
  "Шаг уже отмечен выполненным (done: true) — статус не откатывать ради правки отчёта. Дописать или исправить можно поле result через PATCH /api/subtasks/:id.",
  "Название задачи — суть проблемы; описание — та же проблема подробнее: с чем столкнулись и почему мешает, не копия аудита. Название шага — решение этой проблемы, а не ярлык: не «Единая левая кромка», а что сделать, чтобы проблемы не стало.",
  "Карточка — только ход работы: за что взялся, что сделал. Обсуждения, вопросы коллегам и согласования — в чат координации, а не в ленту карточки.",
  "ДРОБЛЕНИЕ РАБОТЫ (владелец 12.10.2026). По умолчанию — одна карточка с планом командной работы: роли и параллельные шаги внутри неё. Дочерняя карточка — только для самостоятельного результата со своей жизнью: его принимают отдельно, его делает другая цепочка специалистов, его может понадобиться остановить или закрыть независимо, ему нужны свои документы и обсуждение. Одинаковая работа по нескольким областям — одна карточка с параллельными шагами. Ни число шагов, ни параллельность, ни разные инструменты сами по себе дочерних карточек не требуют. Нарезает оркестратор; исполнитель дочерние сам не заводит — нужен ещё специалист, просит шаг в плане (request_help / add_step).",
  "ИНТЕГРАЦИЯ КОДА (владелец 09–28.10.2026). Ответственный за интеграцию один — тот, кто записан в поле карточки «Ответственный за интеграцию»; другого не выдумывай. Если в поле пусто: оркестратор → архитектор → единственный исполнитель. Работа без правок репозитория — «Не требуется». Интеграция — опубликовать свою правку в main без PR: исключительно точечные локальные проверки → коммит своих файлов → при необходимости локальное слияние ветки в main → прямой push main в GitHub. PR не создавать, CI/автослияние не ждать; владелец не нажимает Merge и не даёт повторное разрешение. Полные и глобальные тестовые прогоны запрещены. Конфликт или падение точечной проверки — исправить только свою правку с сохранением чужой работы. Передача принятой версии после ревью — продолжение того же поручения: проверь ветку, коммиты и проверки, уже влитое повторно не вливай. В отчёте различай: разработано, проверено, опубликовано в main (SHA), выложено. Не создавай второго ответственного, свой шаг интеграции, барьеры сдачи или запрет ревью; не закрывай карточку за владельца.",
  "Создаёшь задачу — обязательно с projectId. Уверен — выбери существующий проект по смыслу. Не уверен — задачу без проекта не создавай: предложи владельцу существующий проект (какой и почему), новый (с названием) или спроси, куда отнести.",
];
/** Правила карточки: текст берётся из реестра (R272), литерал — запасной путь при role_registry_enabled=false.
 *  Массив вычисляется при каждом обращении, чтобы API и потребители видели правку реестра без рестарта. */
let agentRulesCache: { text: string; items: string[] } | null = null;
const liveAgentRules = (): string[] => {
  const literalText = AGENT_RULES_LITERAL.join("\n");
  const text = registryTextOr("карточка: все шаги", "agentState:AGENT_RULES", literalText);
  if (text === literalText) return AGENT_RULES_LITERAL;
  if (agentRulesCache?.text !== text) agentRulesCache = { text, items: text.split("\n") };
  return agentRulesCache.items;
};
export const AGENT_RULES: string[] = new Proxy(AGENT_RULES_LITERAL, {
  get: (_target, prop) => { const live = liveAgentRules(); return Reflect.get(live, prop, live); },
});

/** Предел длины result: «одно-два предложения» — это примерно столько. */
export const RESULT_MAX = 400;
export const NOTE_MAX = 400;
export const SUBTASK_TITLE_MAX = 100;

export type SubtaskWorkContext = {
  /** Текущее состояние шага. */
  from: AgentState | null;
  /** Куда просят перевести. undefined — тело без state, продление аренды. */
  to: AgentState | null | undefined;
  /** Вызывающий — учётка агента (users.type = 'ai'). */
  isAi: boolean;
  /** Состояние самой задачи на момент вызова. */
  taskAgentState: AgentState | null;
  /** Есть ли текст: в теле запроса или уже сохранённый у шага. */
  hasResult: boolean;
  /** Длина присланного текста — для проверки «одно-два предложения». */
  resultLength?: number;
};

/**
 * ПРАВИЛА РАБОТЫ НАД ШАГОМ — здесь, а не в хуках клиента.
 *
 * Максим 20.08.2026: «все эти правила должен контролировать сторонний
 * скрипт, который будет контролировать вообще всех агентов, не только
 * тебя… как политика доступов работает с паролями: хочешь залезть — оп,
 * тебе нельзя». Значит правило = отказ сервера, одинаковый для любого
 * внешнего агента и его субагента, а не памятка в моём CLAUDE.md,
 * который чужому агенту не указ.
 *
 * И следом, о самих статусах: «приступить к работе, не проставив статус
 * задачи, статус подзадачи — нельзя. Статус подзадачи всегда динамический:
 * работаешь над ней — должен быть „в процессе“; заблокировал по какой-то
 * причине — ставишь соответствующий; всё выполнил — на ревью, и дальше
 * продолжаешь следующие шаги».
 *
 * Отсюда три отказа (плюс уже существовавший «result обязателен»):
 *  1. шаг нельзя взять в работу, пока не взята сама задача — иначе в
 *     карточке горит шаг, а сверху «никто не работает»;
 *  2. шаг нельзя сдать на проверку, не побывав в работе — ровно так
 *     статус остаётся мёртвым: агент делает молча и в конце проставляет
 *     «review», а владелец так и не видел, что именно шло;
 *  3. заблокированный шаг обязан объяснить причину — тот же принцип «что
 *     нельзя сделать молча», что у задачи (AGENT-PROTOCOL.md).
 *
 * Проверки 1 и 2 адресованы агентам (`isAi`): владелец правит шаги руками
 * в своём же интерфейсе, и подводить его под 400 нельзя. Требование
 * причины — общее: без текста шаг нечитаем кем угодно он ни был выставлен.
 *
 * ⚠️ Чего сервер знать НЕ может: он не видит, что агент «начал работать».
 * Правило «сначала статус, потом работа» держится косвенно — недостижимым
 * review без in_progress, — а дрейф ловит сторож (scripts/agent_watch.py).
 */
export function subtaskWorkRefusal(
  ctx: SubtaskWorkContext,
): { code: number; error: string } | null {
  const { from, to, isAi, taskAgentState, hasResult } = ctx;

  if (to === "in_progress" && isAi && taskAgentState !== "in_progress") {
    return {
      code: 400,
      error:
        "сначала возьмите саму задачу в работу: POST /api/tasks/<id>/claim — " +
        "шаг не может идти в работу под задачей, которую никто не взял",
    };
  }

  // Агенту review на ШАГЕ не положен вовсе. Приёмка шагов отменена
  // 20.08.2026 («сидеть мне это ревьюить — беспонтовая херня»), review
  // ставится один раз на всю задачу, когда закрыты все шаги. Правило было
  // записано и в CLAUDE.md исполнителя, и в его памяти — и всё равно не
  // удержало: 21.08.2026 агент наставил review пяти шагам подряд, а потом
  // пошёл искать, как закрыть задачу. Максим тогда же: «то есть это опять
  // всё чисто на тоненького работает? И никак это нельзя исправить?».
  // Исправляется здесь: правило держит сервер, а не память исполнителя.
  if (to === "review" && isAi) {
    return {
      code: 400,
      error:
        "шаги закрываются галочкой, а не сдаются по одному: " +
        'PATCH /api/subtasks/<id> {"done":true,"result":"что сделано"}. ' +
        "review ставится ОДИН раз и на всю задачу, когда закрыты все шаги: " +
        'POST /api/tasks/<id>/state {"state":"review"}',
    };
  }

  if (to === "review") {
    if (isAi && from !== "in_progress" && from !== "blocked") {
      return {
        code: 400,
        error:
          "шаг не был в работе: сначала POST /api/subtasks/<id>/work " +
          '{"state":"in_progress"}, потом сдавайте — владелец должен видеть, ' +
          "какой шаг идёт, а не только итог",
      };
    }
    if (!hasResult) {
      return {
        code: 400,
        error: "result обязателен: что сделано в этом шаге",
      };
    }
    if (isAi && (ctx.resultLength ?? 0) > RESULT_MAX) {
      return {
        code: 400,
        error:
          `result слишком длинный (${ctx.resultLength} символов при пределе ${RESULT_MAX}). ` +
          "Владельцу нужно одно-два предложения по-человечески: что в итоге " +
          "сделано, чтобы он мог оценить факт выполнения. Технические " +
          "детали и выдержки из аудита — в базу знаний, не в карточку.",
      };
    }
  }

  if (to === "blocked" && !hasResult) {
    return {
      code: 400,
      error:
        "result обязателен: что именно мешает и каких действий вы ждёте от владельца",
    };
  }

  return null;
}

/**
 * СНЯТЬ РАБОТУ С ШАГОВ ЗАДАЧИ. Вызывается там, где задачу перестаёт вести
 * агент: владелец снял её с исполнителя (POST /state {state:null}), задача
 * закрыта или заново открыта (PATCH /tasks/:id {status}).
 *
 * ⚠️ Зачем это отдельным запросом, а не одним UPDATE по задаче: состояние,
 * которое видит владелец, не всегда хранится у самой задачи. Если её
 * agent_state пуст, routes/tasks.ts (withAgentStale) достраивает его СНИЗУ —
 * незакрытый шаг в in_progress/blocked поднимает наверх «агент работает» /
 * «заблокировано». Поэтому владелец, отпускавший такую задачу, записывал
 * NULL туда, где NULL и так был: карточка перечитывалась и снова оказывалась
 * занятой. Ровно тот случай, на который Максим жаловался 24.08.2026 —
 * «остаются заблокированными даже после выполнения», кнопка есть, а нажатие
 * ни к чему не приводит.
 *
 * Гасим и in_progress, и blocked. Только «в работе» мало: оставшийся
 * заблокированный шаг поднимет задачу в blocked, а системная автоматика
 * такие обходит («заблокирована, ждёт владельца») — отпустили бы формально, а работа так
 * и не возобновилась.
 *
 * Снимается ОТМЕТКА о работе, а не сама работа: result шага и его галочка
 * остаются на месте. Поля — те же три, что снимает закрытие шага галочкой и
 * явное «отпустить шаг» (routes/subtasks.ts). agent_session_id сознательно
 * не трогаем: по нему возвращаются в ту же сессию агента, ради чего его на
 * уровне задачи и берегут (agent-state.ts, COALESCE, прецедент 21.08.2026).
 */
export function releaseSubtaskWork(taskId: string): number {
  return db
    .prepare(
      `UPDATE subtasks SET agent_state = NULL, agent_id = NULL, agent_heartbeat_at = NULL
        WHERE task_id = ? AND done = 0 AND agent_state IN ('in_progress', 'blocked')`,
    )
    .run(taskId).changes;
}

export function logEvent(params: {
  taskId: string;
  actorId: string | null;
  kind: string;
  field?: string | null;
  fromValue?: string | null;
  toValue?: string | null;
}) {
  db.prepare(
    `INSERT INTO task_events (id, task_id, actor_id, kind, field, from_value, to_value)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uid(),
    params.taskId,
    params.actorId,
    params.kind,
    params.field ?? null,
    params.fromValue ?? null,
    params.toValue ?? null,
  );
  // Будим оркестратора (вебхук): только важные виды событий, ошибки глотаются.
  queueOrchestratorEvent({ taskId: params.taskId, kind: params.kind, field: params.field, toValue: params.toValue });
}

/** Запись в реестр диспетчеризации (карточка 5f292e87, режим наблюдения).
 *  Читаемый источник правды: откуда пришёл сигнал, какое условие/команда,
 *  адресат, переданные данные, исход и ошибка. Ничего не запускает. */
export function registryRecord(params: {
  source: string;
  trigger: string;
  toUserId?: string | null;
  data?: Record<string, unknown> | null;
  result?: string | null;
  error?: string | null;
}) {
  db.prepare(
    `INSERT INTO dispatch_registry
       (id, source, trigger, to_user_id, data, result, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    uid(),
    params.source,
    params.trigger,
    params.toUserId ?? null,
    params.data ? JSON.stringify(params.data) : null,
    params.result ?? null,
    params.error ?? null,
  );
}
