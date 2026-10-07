import db from "../db.js";

/**
 * Результаты шагов плана — человеческим языком, для владельца (07.10.2026: «роль — результат
 * называется так-то; столько документов, сколько ролей участвовало; открыл и прочитал»).
 * То, чем пользуются роли (структурный результат, его ключи и документ с JSON), не меняется:
 * здесь только представление тех же данных для чтения человеком — в секции «Итог» карточки.
 */
const ARTIFACT_TITLES: Record<string, string> = {
  feature_spec: "Постановка задачи",
  architecture_decision: "Архитектурное решение",
  feature_ux_spec: "Экраны и состояния",
  implementation_pack: "Реализация",
  feature_test_report: "Отчёт о проверке",
  result_pack: "Результат работы",
  card_result: "Результат работы",
};

const FIELD_TITLES: Record<string, string> = {
  scope: "Что входит в задачу", out_of_scope: "Что не входит", acceptance_criteria: "Критерии приёмки",
  nfr: "Требования к качеству", open_questions: "Открытые вопросы",
  context: "Исходная ситуация", options: "Варианты", decision: "Решение", consequences: "Последствия",
  rollout_rollback: "Выкладка и откат", rollout: "Выкладка", rollback: "Откат",
  screens: "Экраны", state_matrix: "Состояния экранов", accessibility: "Доступность",
  change_refs: "Что изменено", build_id: "Сборка", test_report: "Тесты", deployment_notes: "Заметки к выкладке",
  known_limitations: "Известные ограничения",
  acceptance_matrix: "Проверка по критериям", evidence: "Доказательства", defects: "Дефекты", recommendation: "Рекомендация",
  summary: "Коротко", document_refs: "Документы", risks: "Риски", notes: "Заметки",
};

const fieldTitle = (key: string): string => FIELD_TITLES[key] ?? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

function inline(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") {
    if (Array.isArray(value)) return value.map(inline).join("; ");
    return Object.entries(value as Record<string, unknown>).map(([k, v]) => `${fieldTitle(k).toLowerCase()}: ${inline(v)}`).join("; ");
  }
  return String(value);
}

function block(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.map((item) => `- ${inline(item)}`).join("\n") : "—";
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).map(([k, v]) => `- **${fieldTitle(k)}:** ${inline(v)}`).join("\n");
  }
  return inline(value);
}

/** Структурный результат шага — связным текстом с русскими заголовками. */
export function humanResultBody(summary: string | null, payloadJson: string | null, fallback: string | null): string {
  const parts: string[] = [];
  if (summary?.trim()) parts.push(summary.trim());
  let payload: unknown = null;
  try { payload = payloadJson ? JSON.parse(payloadJson) : null; } catch { payload = null; }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) parts.push(`### ${fieldTitle(key)}\n\n${block(value)}`);
  } else if (!parts.length && fallback?.trim()) {
    parts.push(fallback.trim());
  }
  return parts.join("\n\n");
}

/** Человеческие название и текст результата одного шага; null — структурного результата нет. */
export function humanStepResult(subtaskId: string): { title: string | null; body: string } | null {
  const a = db.prepare("SELECT artifact_key, summary, payload_json FROM subtask_artifact_versions WHERE subtask_id = ? ORDER BY version_no DESC LIMIT 1")
    .get(subtaskId) as { artifact_key: string; summary: string | null; payload_json: string | null } | undefined;
  if (!a) return null;
  return { title: ARTIFACT_TITLES[a.artifact_key] ?? null, body: humanResultBody(a.summary, a.payload_json, null) };
}
