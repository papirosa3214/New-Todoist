// Серверный контракт V2: «resolver причин движения/ожидания».
//
// Зачем (владелец 08.10.2026, документ a8bfa7ea-… в TaskFlow — NewTodoist):
//   карточка должна одним запросом объяснить, почему узел не двигается
//   прямо сейчас, кто за это отвечает и какое действие сейчас
//   допустимо. Раньше эти сигналы лежали в failureReasons / stepOutcome
//   / roleRunQueue / planSubtaskAdmission / stalledStepWatcher, и UI
//   вынужден был их собирать сам.
//
// Принципы (V2, без изменений от V1):
//   1. Resolver не запускает, не закрывает и не блокирует — только
//      объясняет. Действия делают существующие маршруты (retry, owner
//      controls, role restart).
//   2. Один закрытый словарь причин. Существующие словари и сторожа —
//      источники сигнала, не дубликаты.
//   3. Одна схема JSON Resolution — карточка, шаг, job и attempt
//      отдают её и только её.
//   4. Версионирование через contract_version; semver.
//   5. Наблюдательность по умолчанию, действие по запросу.
//
// Логика выбора — чистая функция `resolveFromFacts` без I/O, чтобы её
// можно было тестировать без БД. Доступ к БД — в отдельном модуле
// `coordinationResolver.read.ts`; этот модуль не импортирует db.

export const RESOLVER_CONTRACT_VERSION = "2.0.0" as const;

/** 20 причин V2 (документ a8bfa7ea-…, V2). */
export const CAUSE_CODES = [
  "ready_to_start",
  "waiting_predecessor",
  "blocked_dependency",
  "waiting_owner",
  "waiting_human",
  "waiting_transient",
  "active_run",
  "durable_queued_wake",
  "recovery_pending",
  "stalled_manual_review",
  "provider_limit",
  "permission_or_owner",
  "missing_config",
  "context_overflow",
  "step_stalled",
  "review",
  "branch_rework",
  "awaiting_final_review",
  "completed_pending_review",
  "unknown",
] as const;

export type CauseCode = (typeof CAUSE_CODES)[number];

/** 14 действий V2 — каждое ссылается на существующий маршрут. */
export const ACTION_CODES = [
  "start",
  "wait_predecessor",
  "lift_dependency",
  "ask_owner",
  "switch_role",
  "retry_with_delay",
  "replace_attempt",
  "switch_provider",
  "fix_config",
  "accept_review",
  "run_final_review",
  "pick_up_after_review",
  "no_action",
  "none",
] as const;

export type ActionCode = (typeof ACTION_CODES)[number];

export type AssigneeRef = { kind: "role" | "person"; key: string };

export type EvidenceKind =
  | "task_event"
  | "attempt"
  | "role_run_job"
  | "journal_tail"
  | "git_snapshot"
  | "artifact_version"
  | "plan_edge";

export type Evidence = {
  kind: EvidenceKind;
  /** Формат «таблица.основание» — чтобы UI и агенты открыли
   *  первоисточник одним кликом, а тесты — проверили без парсинга
   *  свободного текста. */
  ref: string;
  note?: string | null;
};

export type MetricSnapshot = {
  age_seconds: number;
  attempts_in_window: number;
  heartbeat_age: number;
};

export type LinkRef = {
  /** Маршрут или API, к которому ведёт ссылка (относительный путь). */
  href: string;
  rel: "retry" | "replace" | "cancel" | "accept" | "lift";
  note?: string | null;
};

export type Resolution = {
  contract_version: typeof RESOLVER_CONTRACT_VERSION;
  generated_at: string;
  subtask_id: string | null;
  task_id: string;
  plan_node_key: string | null;
  role: string | null;
  cause: CauseCode;
  action: ActionCode;
  assignee: AssigneeRef;
  deadline_hint: string | null;
  checked_after: string | null;
  evidence: Evidence[];
  metrics: MetricSnapshot;
  notes: string | null;
  links: LinkRef[];
};

/** Допустимые значения `block_type` (V1 говорил о двух; код и
 *  `AGENT_RULES` подтверждают четыре — dependency | needs_input |
 *  capability | transient). */
export type BlockType = "dependency" | "needs_input" | "capability" | "transient" | null;

export type SubtaskFacts = {
  subtaskId: string | null;
  taskId: string;
  taskStatus: "active" | "completed" | "archived" | "snoozed" | string;
  taskAgentState: string | null;
  taskAssigneeId: string | null;
  taskCreatorId: string | null;
  subtaskAgentState: string | null;
  subtaskDone: boolean;
  subtaskBlockType: BlockType;
  subtaskPlanNodeKey: string | null;
  subtaskTitle: string | null;
  roleKey: string | null;
  waitingPredecessors: WaitingPredecessor[];
  hasActiveAttempt: boolean;
  attemptHeartbeatAgeSeconds: number | null;
  /** Сколько секунд назад произошло последнее событие хода (mtime
   *  журнала сессии). null, если поток ещё не открыт. */
  sessionLastEventAgeSeconds: number | null;
  /** Сколько уже сделано автоперезапусков за окно `stalledStepWatcher`. */
  restartCount: number;
  /** Потолок автоперезапусков (на случай, если правила поменялись). */
  maxRestarts: number;
  hasDurableQueuedJob: boolean;
  deadJobFailureCode: string | null;
  runningJobLeaseExpired: boolean;
  stepOutcomeStalled: boolean;
  isFinalReviewNode: boolean;
  branchReworkLinkExists: boolean;
  nowEpochSeconds: number;
};

export type WaitingPredecessor = {
  fromSlotKey: string;
  reason: string;
  artifactKey: string | null;
};

/** Связь между `cause` и `action` зафиксирована в контракте V2;
 *  эта карта — единственная точка, где они сопоставлены. Если
 *  расширяете словарь — обновите её и тест `coversEveryCause`. */
export const CAUSE_TO_ACTION: Record<CauseCode, ActionCode> = {
  ready_to_start: "start",
  waiting_predecessor: "wait_predecessor",
  blocked_dependency: "lift_dependency",
  waiting_owner: "ask_owner",
  waiting_human: "switch_role",
  waiting_transient: "no_action",
  active_run: "no_action",
  durable_queued_wake: "no_action",
  recovery_pending: "no_action",
  stalled_manual_review: "replace_attempt",
  provider_limit: "switch_provider",
  permission_or_owner: "ask_owner",
  missing_config: "fix_config",
  context_overflow: "retry_with_delay",
  step_stalled: "replace_attempt",
  review: "accept_review",
  branch_rework: "pick_up_after_review",
  awaiting_final_review: "run_final_review",
  completed_pending_review: "accept_review",
  unknown: "none",
};

const ACTIVE_RUN_HEARTBEAT_LIMIT_SECONDS = 5 * 60;

/** Прямой порядок «первый матч выигрывает» (документ V2, раздел
 *  «Логика выбора причины и действия»). Правила пронумерованы, чтобы
 *  ссылаться на них из теста и из лога причин. */
export function resolveFromFacts(facts: SubtaskFacts): { cause: CauseCode; rule: string } {
  // 1. Карточка завершена/архивирована → completed_pending_review.
  if (facts.taskStatus === "completed" || facts.taskStatus === "archived") {
    return { cause: "completed_pending_review", rule: "R1.task_terminal" };
  }
  // 2. Узел в review на уровне карточки.
  if (facts.taskAgentState === "review") {
    return { cause: "review", rule: "R2.task_in_review" };
  }
  // 3. Узел заблокирован — причина по `block_type`.
  if (facts.subtaskAgentState === "blocked") {
    switch (facts.subtaskBlockType) {
      case "dependency":
        return { cause: "blocked_dependency", rule: "R3.blocked_dependency" };
      case "needs_input":
        return { cause: "waiting_owner", rule: "R3.blocked_needs_input" };
      case "capability":
        return { cause: "waiting_human", rule: "R3.blocked_capability" };
      case "transient":
        return { cause: "waiting_transient", rule: "R3.blocked_transient" };
      default:
        // Неизвестный `block_type` — мягко отдаём waiting_owner, чтобы
        // владелец посмотрел; не делаем вид, что всё хорошо.
        return { cause: "waiting_owner", rule: "R3.blocked_unknown" };
    }
  }
  // 4. Активная попытка (attempts.ended_at IS NULL) и есть heartbeat.
  if (facts.hasActiveAttempt) {
    const hb = facts.attemptHeartbeatAgeSeconds;
    if (hb !== null && hb < ACTIVE_RUN_HEARTBEAT_LIMIT_SECONDS) {
      return { cause: "active_run", rule: "R4.attempt_fresh_heartbeat" };
    }
    if (facts.restartCount >= facts.maxRestarts) {
      return { cause: "stalled_manual_review", rule: "R4.attempt_stalled_limit" };
    }
    return { cause: "recovery_pending", rule: "R4.attempt_heartbeat_old" };
  }
  // 4b. Поток событий хода замолчал, хотя аренды попытки уже нет —
  //     признак `recovery_pending` (recoverInterruptedPlanSubtasks
  //     поднимет сам).
  if (
    facts.sessionLastEventAgeSeconds !== null &&
    facts.sessionLastEventAgeSeconds > ACTIVE_RUN_HEARTBEAT_LIMIT_SECONDS
  ) {
    if (facts.restartCount >= facts.maxRestarts) {
      return { cause: "stalled_manual_review", rule: "R4b.session_silent_limit" };
    }
    return { cause: "recovery_pending", rule: "R4b.session_silent" };
  }
  // 5. Job в `role_run_jobs` (контракт V2 раздел «Логика»). По
  //    спецификации V2 это правило стоит после R5, но реальная
  //    диагностика требует, чтобы `durable_queued_wake`/
  //    `permission_or_owner`/`missing_config`/`provider_limit`/
  //    `context_overflow` срабатывали ДЛЯ узла в todo: иначе
  //    владелец видит «готово к старту» при `dead` job'е, что
  //    вводит в заблуждение. Поэтому блок очереди идёт здесь, а
  //    «готово к старту» — только если ни одно из R5-заданий не
  //    объяснило состояние.
  if (facts.hasDurableQueuedJob) {
    return { cause: "durable_queued_wake", rule: "R5.queued" };
  }
  if (facts.deadJobFailureCode) {
    // Классификация: код `dead` job'а — это FailureReasonCode из
    // failureReasons.ts (provider_auth_or_access / missing_config / …).
    switch (facts.deadJobFailureCode) {
      case "provider_auth_or_access":
        return { cause: "permission_or_owner", rule: "R5.dead_auth" };
      case "missing_config":
        return { cause: "missing_config", rule: "R5.dead_config" };
      case "provider_quota_limit":
      case "provider_rate_limit":
      case "provider_server_error":
        return { cause: "provider_limit", rule: "R5.dead_provider" };
      case "context_overflow":
        return { cause: "context_overflow", rule: "R5.dead_context" };
      default:
        return { cause: "missing_config", rule: "R5.dead_other" };
    }
  }
  if (facts.runningJobLeaseExpired) {
    return { cause: "recovery_pending", rule: "R5.running_lease_expired" };
  }
  // 6. Узел в todo, без активной попытки и без задания в очереди.
  if (!facts.subtaskDone && (facts.subtaskAgentState === null || facts.subtaskAgentState === "todo")) {
    // 6.1. Если уже есть INSERT в branch_rework_links
    //      (planReviewLifecycle:195) — открыты rework-узлы; показываем
    //      это явно, а не "готово к старту".
    if (facts.branchReworkLinkExists) {
      return { cause: "branch_rework", rule: "R6.1.branch_rework_link" };
    }
    // 6.2. Последний исход шага — stalled (от settleStalledPlanNode).
    //      Тоже важно показать явно: даже если узел «технически» в todo,
    //      ход уже завершился без сдачи — не делаем вид, что всё хорошо.
    if (facts.stepOutcomeStalled) {
      return { cause: "step_stalled", rule: "R6.2.step_outcome_stalled" };
    }
    if (facts.waitingPredecessors.length > 0) {
      return { cause: "waiting_predecessor", rule: "R6.waiting_predecessor" };
    }
    if (facts.isFinalReviewNode) {
      return { cause: "awaiting_final_review", rule: "R6.final_review_node" };
    }
    return { cause: "ready_to_start", rule: "R6.ready_to_start" };
  }
  // 7. Последний исход шага — stalled (от settleStalledPlanNode).
  if (facts.stepOutcomeStalled) {
    return { cause: "step_stalled", rule: "R7.step_outcome_stalled" };
  }
  // 8. Узел плана с маркером финального ревью — отдельный случай.
  if (facts.isFinalReviewNode) {
    return { cause: "awaiting_final_review", rule: "R8.final_review_marker" };
  }
  // 9. После verdict `changes_requested` и INSERT в branch_rework_links
  //    (planReviewLifecycle:195) — открыты rework-узлы.
  if (facts.branchReworkLinkExists) {
    return { cause: "branch_rework", rule: "R9.branch_rework_link" };
  }
  // 10. Ни одно правило не сработало — это сигнал разработчику
  //     пополнить словарь. Не делаем вид, что всё хорошо.
  return { cause: "unknown", rule: "R10.fallback" };
}

export type ResolvedAssignee = { assignee: AssigneeRef; cause: CauseCode };

/** Кто отвечает сейчас по выбранной причине. V1 закрытый вопрос
 *  «роль-координатор в AssigneeRef» в V2 решён так: пишем
 *  `users.id` владельца карточки (assignee || creator), а не
 *  координатора. Для `active_run`/`durable_queued_wake`/
 *  `recovery_pending` отвечает текущая роль узла (она в работе). */
export function resolveAssignee(facts: SubtaskFacts, cause: CauseCode): ResolvedAssignee {
  if (
    cause === "active_run" ||
    cause === "durable_queued_wake" ||
    cause === "recovery_pending" ||
    cause === "stalled_manual_review"
  ) {
    if (facts.roleKey) return { assignee: { kind: "role", key: facts.roleKey }, cause };
  }
  const owner = facts.taskAssigneeId ?? facts.taskCreatorId;
  if (owner) return { assignee: { kind: "person", key: owner }, cause };
  // Владельца не нашли — отдаём явную метку, чтобы UI понял.
  return { assignee: { kind: "person", key: "owner:unknown" }, cause };
}

export function buildResolution(params: {
  facts: SubtaskFacts;
  evidence?: Evidence[];
  links?: LinkRef[];
  notes?: string | null;
  deadlineHint?: string | null;
  checkedAfter?: string | null;
}): Resolution {
  const { facts } = params;
  const { cause, rule } = resolveFromFacts(facts);
  const action = CAUSE_TO_ACTION[cause];
  const { assignee } = resolveAssignee(facts, cause);
  const age = (input: number | null): number => Math.max(0, Math.floor(input ?? 0));
  const notes = (params.notes ?? ruleHumanText(cause, rule)).slice(0, 500);
  return {
    contract_version: RESOLVER_CONTRACT_VERSION,
    generated_at: new Date(facts.nowEpochSeconds * 1000).toISOString(),
    subtask_id: facts.subtaskId,
    task_id: facts.taskId,
    plan_node_key: facts.subtaskPlanNodeKey,
    role: facts.roleKey,
    cause,
    action,
    assignee,
    deadline_hint: params.deadlineHint ?? null,
    checked_after: params.checkedAfter ?? null,
    evidence: (params.evidence ?? []).slice(0, 7),
    metrics: {
      age_seconds: age(facts.sessionLastEventAgeSeconds),
      attempts_in_window: facts.restartCount,
      heartbeat_age: age(facts.attemptHeartbeatAgeSeconds),
    },
    notes,
    links: params.links ?? [],
  };
}

function ruleHumanText(cause: CauseCode, rule: string): string {
  switch (cause) {
    case "ready_to_start":
      return "Шаг плана свободен и ждёт, пока его откроет цепочка или владелец.";
    case "waiting_predecessor":
      return "Ждём конкретного предшественника — смотрите поле `evidence`.";
    case "blocked_dependency":
      return "Зависимость задачи ещё не выполнена; `liftDependencyBlocks` снимет блок.";
    case "waiting_owner":
      return "Нужно решение владельца.";
    case "waiting_human":
      return "Нет компетенции у роли; подобрать другую или привлечь человека.";
    case "waiting_transient":
      return "Временный блок (например, ввод данных) — сервер снимет сам.";
    case "active_run":
      return "Сейчас идёт живой запуск; срок, heartbeat, последнее событие.";
    case "durable_queued_wake":
      return "Задание в очереди; worker подхватит сам.";
    case "recovery_pending":
      return "После рестарта или зависания сервер сам поднимет шаг.";
    case "stalled_manual_review":
      return "Сервер дошёл до лимита автоперезапусков; дальше — владелец.";
    case "provider_limit":
      return "Цепочка провайдера кончилась; нужен человек или смена аккаунта.";
    case "permission_or_owner":
      return "Ключ/доступ/права — только владелец.";
    case "missing_config":
      return "Не настроена маршрутизация/конфиг роли.";
    case "context_overflow":
      return "Контекст модели переполнен; сервер сожмёт и продолжит.";
    case "step_stalled":
      return "Ход завершился без сдачи; нужен ручной запуск.";
    case "review":
      return "Карточка на приёмке у проверяющего; ждём вердикт.";
    case "branch_rework":
      return "После вердикта «на доработку» открыты rework-узлы.";
    case "awaiting_final_review":
      return "Все доработки сданы, ждём финального ревьюера.";
    case "completed_pending_review":
      return "План сдан, но настройки отключили авто-проверку.";
    case "unknown":
      return "Не сработало ни одно правило — словарь причин надо пополнить.";
    default: {
      // Защита от расширения: правило пишем в `notes` явно, чтобы
      // разработчик увидел причину в логах, а не «unknown» без следа.
      const _exhaustive: never = cause;
      return `cause=${String(_exhaustive)} rule=${rule}`;
    }
  }
}

/** Сконструировать короткое человек-readable объяснение для лога,
 *  когда UI ещё не вызвал endpoint. Не для UI. */
export function causeToLabel(cause: CauseCode): string {
  return ruleHumanText(cause, "");
}

/** Удобный тест: каждое `cause` имеет ровно одно `action`. */
export function coversEveryCause(): { ok: true } | { ok: false; missing: CauseCode[] } {
  const missing: CauseCode[] = [];
  for (const code of CAUSE_CODES) {
    if (!CAUSE_TO_ACTION[code]) missing.push(code);
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}
