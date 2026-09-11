import crypto from "crypto";
import db from "./db.js";

export type EnrichmentCandidate = {
  profile: string;
  score: number;
  matched_terms: string[];
};

export type EnrichmentResult = {
  input_text: string;
  selected_profile: string | null;
  confidence: number;
  candidates: EnrichmentCandidate[];
  reason: string | null;
};

// Источник профилей — server/scripts/team_catalog.json. Термины здесь
// намеренно короткие и детерминированные: enricher не вызывает LLM.
const PROFILE_TERMS: Record<string, string[]> = {
  claude_bot: ["server", "backend", "api", "sql", "sqlite", "python", "typescript", "migration", "database", "тест", "тесты"],
  hermes: ["integration", "integrations", "интегра", "monitoring", "мониторинг", "deploy", "deployment", "docker", "ops"],
  antigravity: ["ios", "swift", "swiftui", "native", "натив", "ui", "interface", "design system"],
  pi_agent: ["misc", "прочее", "общее"],
  deepseek: ["research", "исслед", "analysis", "аналит", "reasoning", "изуч", "сравн"],
  reviewer: ["review", "ревью", "verify", "провер", "qa", "audit", "аудит"],
  orchestrator: ["orchestrat", "оркестр", "queue", "очеред", "assign", "назнач", "routing", "маршрут"],
};

const MIN_SCORE = 2;
const MIN_MARGIN = 1;

function normalize(input: string): string {
  return input.toLocaleLowerCase().replace(/[\u2013\u2014]/g, "-");
}

export function profileOfUser(userId: string): string | null {
  const row = db.prepare("SELECT profile FROM users WHERE id = ?").get(userId) as
    | { profile?: string | null }
    | undefined;
  return row?.profile ?? null;
}

export function analyzeTask(title: string, description?: string | null): EnrichmentResult {
  const input_text = `${title}\n${description ?? ""}`.trim();
  const text = normalize(input_text);
  const candidates = Object.entries(PROFILE_TERMS)
    .map(([profile, terms]) => {
      const matched_terms = terms.filter((term) => text.includes(term));
      return { profile, score: matched_terms.length, matched_terms };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.profile.localeCompare(b.profile));

  const top = candidates[0];
  const next = candidates[1];
  const confident = Boolean(
    top && top.score >= MIN_SCORE && (!next || top.score - next.score >= MIN_MARGIN),
  );
  return {
    input_text,
    selected_profile: confident ? top.profile : null,
    confidence: top ? top.score / Object.keys(PROFILE_TERMS).length : 0,
    candidates,
    reason: confident
      ? null
      : top
        ? "низкая или неоднозначная уверенность"
        : "не найдено подходящих компетенций",
  };
}

export function taskDependencies(taskId: string): Array<{ id: string; title: string; status: string }> {
  return db
    .prepare(
      `SELECT t.id, t.title, t.status
         FROM task_dependencies d
         JOIN tasks t ON t.id = d.depends_on_task_id
        WHERE d.task_id = ? ORDER BY d.created_at, t.id`,
    )
    .all(taskId) as Array<{ id: string; title: string; status: string }>;
}

export function unmetDependencyIds(taskId: string): string[] {
  return (db
    .prepare(
      `SELECT t.id FROM task_dependencies d
         JOIN tasks t ON t.id = d.depends_on_task_id
        WHERE d.task_id = ? AND t.status <> 'completed'`,
    )
    .all(taskId) as Array<{ id: string }>).map((row) => row.id);
}

export function profileLabelName(profile: string): string {
  return `profile:${profile}`;
}

export function ensureProfileLabel(profile: string, ownerId: string): string {
  const name = profileLabelName(profile);
  const existing = db
    .prepare("SELECT id FROM labels WHERE name = ? ORDER BY owner_id IS NULL, id LIMIT 1")
    .get(name) as { id?: string } | undefined;
  if (existing?.id) return existing.id;
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO labels (id, name, color, owner_id) VALUES (?, ?, ?, ?)").run(
    id,
    name,
    "#6B8AFD",
    ownerId,
  );
  return id;
}

export function attachLabel(taskId: string, labelId: string): void {
  db.prepare("INSERT OR IGNORE INTO task_labels (task_id, label_id) VALUES (?, ?)").run(taskId, labelId);
}

export function hasProfileLabel(taskId: string, profile: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM task_labels tl JOIN labels l ON l.id = tl.label_id
          WHERE tl.task_id = ? AND l.name = ? LIMIT 1`,
      )
      .get(taskId, profileLabelName(profile)),
  );
}

export function poolTasksForUser(userId: string): any[] {
  const profile = profileOfUser(userId);
  if (!profile) return [];
  return db
    .prepare(
      `SELECT t.* FROM tasks t
        WHERE t.status = 'active' AND t.assignee_id IS NULL
          AND t.ready_for_pickup = 1
          AND EXISTS (
            SELECT 1 FROM task_labels tl JOIN labels l ON l.id = tl.label_id
             WHERE tl.task_id = t.id AND l.name = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.id = d.depends_on_task_id
             WHERE d.task_id = t.id AND dep.status <> 'completed'
          )
          AND (t.agent_state IS NULL OR t.agent_state = 'blocked')
        ORDER BY t.priority DESC, t.created_at ASC, t.id ASC`,
    )
    .all(profileLabelName(profile));
}
/**
 * Why an unassigned task is or is not available to a self-claiming agent.
 * The pool and the claim endpoint must use the same gate: an empty
 * assignee_id is not itself an invitation to take arbitrary work.
 */
export function selfClaimEligibilityError(
  taskId: string,
  userId: string,
): string | null {
  const profile = profileOfUser(userId);
  if (!profile || !hasProfileLabel(taskId, profile)) {
    return "задача не опубликована в пуле для профиля этого агента";
  }
  if (unmetDependencyIds(taskId).length > 0) {
    return "задача ждёт завершения зависимостей — взять её можно после их приёмки";
  }
  return null;
}

export function isTaskInSelfClaimPool(taskId: string, userId: string): boolean {
  if (selfClaimEligibilityError(taskId, userId)) return false;
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM tasks
          WHERE id = ? AND status = 'active' AND assignee_id IS NULL
            AND ready_for_pickup = 1
            AND (agent_state IS NULL OR agent_state = 'blocked')`,
      )
      .get(taskId),
  );
}
