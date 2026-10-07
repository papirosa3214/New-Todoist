import db from "../db.js";
import { roleTitle } from "../roleRouting.js";

/**
 * Результаты шагов плана — человеческим языком, для владельца (07.10.2026: «роль — результат
 * называется так-то; столько документов, сколько ролей участвовало; открыл и прочитал»).
 * То, чем пользуются роли (структурный результат, его ключи и документ с JSON), не меняется:
 * здесь только представление тех же данных для чтения человеком.
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

export type StepResult = {
  subtask_id: string; role_key: string; role_title: string; title: string; body: string;
  note_id: string | null; version_no: number | null; created_at: string | null;
};

/** Закрытые шаги плана задачи с их результатами, по порядку шагов. */
export function taskStepResults(taskId: string): StepResult[] {
  const rows = db.prepare(
    `SELECT s.id, s.title, s.result, n.role_key, a.artifact_key, a.summary, a.payload_json, a.note_id, a.version_no, a.created_at
       FROM subtasks s
       JOIN task_collaboration_plan_nodes n ON n.plan_id = s.collaboration_plan_id AND n.slot_key = s.plan_node_key
       LEFT JOIN subtask_artifact_versions a ON a.id = (SELECT id FROM subtask_artifact_versions WHERE subtask_id = s.id ORDER BY version_no DESC LIMIT 1)
      WHERE s.task_id = ? AND s.done = 1 AND n.skipped_at IS NULL
      ORDER BY s.position`,
  ).all(taskId) as Array<{ id: string; title: string; result: string | null; role_key: string; artifact_key: string | null; summary: string | null; payload_json: string | null; note_id: string | null; version_no: number | null; created_at: string | null }>;
  return rows
    .map((r) => ({
      subtask_id: r.id,
      role_key: r.role_key,
      role_title: roleTitle(r.role_key as any),
      title: (r.artifact_key && ARTIFACT_TITLES[r.artifact_key]) || (r.role_key === "critic_verifier" ? "Заключение Критика" : r.role_key === "qa" ? "Отчёт о проверке" : "Результат работы"),
      body: humanResultBody(r.summary, r.payload_json, r.result),
      note_id: r.note_id,
      version_no: r.version_no,
      created_at: r.created_at,
    }))
    .filter((r) => r.body);
}
