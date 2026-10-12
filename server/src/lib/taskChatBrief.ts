// Первое, что получает роль, проснувшаяся в чате задачи.
//
// Владелец 12.10.2026: в чате задачи он общается с исполнителями именно по
// этой задаче. Роль каждый раз просыпается «новенькой», и ей нужен не снимок
// всего окружения, а акцент: ты участник ЭТОЙ задачи, разговор о ней, сначала
// изучи её досконально. Раньше справка о задаче шла последним блоком после
// общей обёртки и не содержала ни описания карточки, ни шагов роли.

import db from "../db.js";

const clip = (text: string | null | undefined, max: number) => {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
};

export function taskChatBrief(taskId: string, role: string): string {
  const task = db
    .prepare("SELECT title, description, status, agent_state FROM tasks WHERE id = ?")
    .get(taskId) as { title: string; description: string | null; status: string; agent_state: string | null } | undefined;
  if (!task) return "";
  const mine = db
    .prepare(
      `SELECT s.title, s.done, s.agent_state, s.result, s.plan_node_key
         FROM subtasks s
         JOIN task_collaboration_plan_nodes n ON n.plan_id = s.collaboration_plan_id AND n.slot_key = s.plan_node_key
         JOIN task_collaboration_plans p ON p.id = n.plan_id AND p.status = 'approved'
        WHERE s.task_id = ? AND n.role_key = ? AND n.skipped_at IS NULL
        ORDER BY s.position`,
    )
    .all(taskId, role) as Array<{ title: string; done: number; agent_state: string | null; result: string | null; plan_node_key: string }>;
  const state = task.status !== "active" ? "закрыта" : task.agent_state === "review" ? "на проверке" : task.agent_state === "blocked" ? "заблокирована" : task.agent_state === "in_progress" ? "в работе" : "открыта";
  const stepState = (s: { done: number; agent_state: string | null }) =>
    s.done ? "сдан" : s.agent_state === "in_progress" ? "в работе" : s.agent_state === "blocked" ? "заблокирован" : s.agent_state === "review" ? "на проверке" : "ещё не начат";
  return [
    "ЗАДАЧА ЭТОГО РАЗГОВОРА — главное в этом ходе, важнее остального контекста ниже.",
    `Ты участник задачи «${clip(task.title, 200)}» (id ${taskId}, сейчас ${state}). Владелец пишет тебе в чате этой задачи: разговор идёт о ней, а не о проекте вообще.`,
    "Прежде чем отвечать, изучи задачу целиком доступными тебе инструментами чтения: саму карточку и её описание, план и своё место в нём, результаты уже сданных шагов, документы и переписку задачи. Отвечай по фактам этой задачи; если чего-то в ней нет или ты этого не проверил — так и скажи.",
    task.description ? `Описание задачи: ${clip(task.description, 1500)}` : "Описания у задачи нет.",
    mine.length
      ? "Твои шаги в этой задаче:\n" + mine.map((s) => `- слот ${s.plan_node_key}: ${clip(s.title, 160)} — ${stepState(s)}${s.result ? `; результат: ${clip(s.result, 400)}` : ""}`).join("\n")
      : "Своего шага в плане этой задачи у тебя нет: ты отвечаешь как участник обсуждения.",
  ].join("\n");
}
