// Что роль знает в чате задачи (владелец 05.11.2026).
//
// Роль знает свой кусок работы и карту команды: кто что делает, где она сейчас,
// что к ней приходит и кому она сдаёт. Чужие результаты показываются, только
// если они приходят на её этап; итоги шагов копируются как есть.
// Карта та же, что у владельца в «Координации»: состояние этапа даёт тот же разбор.

import db from "../db.js";
import { roleTitle } from "../roleRouting.js";
import { collectFactsForTask } from "../runtime/coordinationResolver.read.js";
import { causeToLabel, resolveFromFacts } from "../runtime/coordinationResolver.js";
import { latestSlotSnapshot, snapshotBlock } from "../runtime/slotWorkSnapshot.js";
import { hasResolutionPlan, slotLabels } from "./slotResolution.js";
import { readWorkPlan } from "./subtaskWorkPlan.js";

/** Роли, чья работа и есть проверка: им совет «не тестируй» не даётся. */
const CHECKING_ROLES = new Set(["qa", "critic_verifier"]);

type PlanNode = {
  subtask_id: string; slot_key: string; role_key: string; expected_result: string;
  done: number; agent_state: string | null; result: string | null; label: string;
};
type TeamPlan = { nodes: PlanNode[]; edges: Array<{ from_slot_key: string; to_slot_key: string }> };

function teamPlan(taskId: string): TeamPlan {
  const rows = db
    .prepare(
      `SELECT s.id subtask_id, n.slot_key, n.role_key, n.expected_result, s.done, s.agent_state, s.result
         FROM subtasks s
         JOIN task_collaboration_plan_nodes n ON n.plan_id = s.collaboration_plan_id AND n.slot_key = s.plan_node_key
         JOIN task_collaboration_plans p ON p.id = n.plan_id AND p.status = 'approved'
        WHERE s.task_id = ? AND n.skipped_at IS NULL
        ORDER BY s.position, s.rowid`,
    )
    .all(taskId) as Array<Omit<PlanNode, "label">>;
  const labels = new Map(slotLabels(taskId).map((slot) => [slot.subtask_id, slot.label]));
  const edges = db
    .prepare(
      `SELECT e.from_slot_key, e.to_slot_key FROM task_collaboration_plan_edges e
         JOIN task_collaboration_plans p ON p.id = e.plan_id AND p.status = 'approved'
        WHERE p.task_id = ?`,
    )
    .all(taskId) as TeamPlan["edges"];
  return { nodes: rows.map((row) => ({ ...row, label: labels.get(row.subtask_id) ?? roleTitle(row.role_key) })), edges };
}

function reachable(start: string, next: (slot: string) => string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    for (const slot of next(queue.pop()!)) {
      if (!seen.has(slot)) { seen.add(slot); queue.push(slot); }
    }
  }
  return seen;
}

function stageStates(taskId: string): Map<string, string> {
  const states = new Map<string, string>();
  try {
    for (const facts of collectFactsForTask(taskId)) {
      if (facts.subtaskId) states.set(facts.subtaskId, causeToLabel(resolveFromFacts(facts).cause));
    }
  } catch (error) {
    console.warn(`[taskChatScope] разбор состояний не собран task=${taskId}:`, error instanceof Error ? error.message : error);
  }
  return states;
}

function stageLine(node: PlanNode, states: Map<string, string>, mine: boolean, here: boolean): string {
  const state = node.done ? "сдан" : states.get(node.subtask_id) || "ещё не начат";
  return `- ${node.label}: ${node.expected_result || "итог не описан"} — ${state}${here ? " ← ТЫ ЗДЕСЬ" : mine ? " (твой этап)" : ""}`;
}

function mapFor(plan: TeamPlan, states: Map<string, string>, role: string, me: PlanNode | undefined): string {
  const lines = [`Карта задачи, этапов ${plan.nodes.length}:`, ...plan.nodes.map((node) => stageLine(node, states, node.role_key === role, node === me))];
  if (!me) return lines.join("\n");

  const incoming = (slot: string) => plan.edges.filter((e) => e.to_slot_key === slot).map((e) => e.from_slot_key);
  const outgoing = (slot: string) => plan.edges.filter((e) => e.from_slot_key === slot).map((e) => e.to_slot_key);
  const before = reachable(me.slot_key, incoming);
  const after = reachable(me.slot_key, outgoing);
  const bySlot = new Map(plan.nodes.map((node) => [node.slot_key, node]));
  const names = (slots: Iterable<string>) => [...slots].map((slot) => bySlot.get(slot)?.label).filter(Boolean).join(", ");

  const parallel = plan.nodes.filter((node) => node !== me && !before.has(node.slot_key) && !after.has(node.slot_key));
  const from = names(incoming(me.slot_key));
  const to = names(outgoing(me.slot_key));
  const checkers = plan.nodes.filter((node) => after.has(node.slot_key) && CHECKING_ROLES.has(node.role_key));

  if (from) lines.push(`Получаешь от: ${from}.`);
  if (parallel.length) lines.push(`Параллельно с тобой: ${parallel.map((node) => node.label).join(", ")}. Это другие куски работы: ты делаешь только свой, их не делаешь и не трогаешь.`);
  lines.push(to ? `Сдаёшь: ${to}.` : "После тебя этапов в плане нет.");
  lines.push(`За этот этап отвечаешь лично ты. Он готов, когда: ${me.expected_result || "итог не описан, уточни у владельца"}. Чужие этапы не выполняешь, самодеятельностью не занимаешься.`);
  if (CHECKING_ROLES.has(me.role_key)) {
    lines.push("Проверка — твоя работа на этом этапе.");
  } else if (checkers.length) {
    lines.push(`Проверят дальше: ${checkers.map((node) => node.label).join(", ")}. С тебя минимальная проверка своей работы: нерабочее не отдавай, но глубокие тесты и перепроверку всего не делай. Думай о качестве самой работы.`);
  } else {
    lines.push("Проверяющего дальше по плану нет: проверка своей работы целиком на тебе.");
  }
  return lines.join("\n");
}

/** Карта для рабочего запуска слота. Без утверждённого плана пусто. */
export function slotTeamMap(subtaskId: string): string {
  const row = db.prepare("SELECT task_id FROM subtasks WHERE id = ?").get(subtaskId) as { task_id: string } | undefined;
  if (!row) return "";
  const plan = teamPlan(row.task_id);
  const me = plan.nodes.find((node) => node.subtask_id === subtaskId);
  if (!me) return "";
  return mapFor(plan, stageStates(row.task_id), me.role_key, me);
}

function ownWork(plan: TeamPlan, me: PlanNode): string[] {
  const out: string[] = [];
  const items = readWorkPlan(me.subtask_id)?.items as Array<{ title: string; state: string }> | undefined;
  if (items?.length) out.push("Твой чек-лист:\n" + items.map((item) => `- ${item.title} — ${item.state === "done" ? "готово" : item.state === "in_progress" ? "в работе" : "не начато"}`).join("\n"));
  if (me.result) out.push(`Итог твоего этапа:\n${me.result}`);
  const snapshot = latestSlotSnapshot(me.subtask_id);
  if (snapshot) out.push(snapshotBlock(snapshot, { title: "Где остановилась твоя работа" }));
  const fromSlots = plan.edges.filter((e) => e.to_slot_key === me.slot_key).map((e) => e.from_slot_key);
  for (const node of plan.nodes.filter((n) => fromSlots.includes(n.slot_key) && n.result)) {
    out.push(`Приходит на твой этап от ${node.label}:\n${node.result}`);
  }
  return out;
}

/** Выжимка и карта для чата задачи. */
export function taskChatTeamBlock(taskId: string, role: string, subtaskId?: string | null): string {
  const plan = teamPlan(taskId);
  if (!plan.nodes.length) return "";
  const mine = plan.nodes.filter((node) => node.role_key === role);
  const me = subtaskId ? mine.find((node) => node.subtask_id === subtaskId) : mine.length === 1 ? mine[0] : undefined;
  const parts = [mapFor(plan, stageStates(taskId), role, me)];
  if (me) parts.push(...ownWork(plan, me));
  else if (mine.length) parts.push(`У тебя несколько этапов (${mine.map((node) => node.label).join(", ")}): говори о том, про который спросил владелец.`);
  else parts.push("Своего этапа в плане у тебя нет: отвечаешь только по этой задаче.");
  return parts.join("\n\n");
}

/** Документы задачи: то, что роль может читать без отдельного слова владельца. */
export function taskDocuments(taskId: string): Array<{ id: string; title: string }> {
  return db
    .prepare(
      `SELECT n.id, COALESCE(NULLIF(n.title,''),'без названия') title FROM user_notes n
         JOIN tasks t ON t.artifact_folder_id = n.folder_id
        WHERE t.id = ? ORDER BY n.updated_at DESC LIMIT 20`,
    )
    .all(taskId) as Array<{ id: string; title: string }>;
}

const STEM = 5;
const COMMON = new Set(["задач", "карто", "этого", "этой", "котор", "можно", "нужно", "почем", "сейча", "посмо", "зайди", "сдела", "работ"]);

function stems(text: string): Set<string> {
  const words = String(text ?? "").toLowerCase().replace(/ё/g, "е").match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  return new Set(words.map((word) => word.slice(0, STEM)).filter((stem) => !COMMON.has(stem)));
}

/** Владелец диктует голосом: карточку узнаём по двум общим словам, а не только по id. */
export function ownerNamed(text: string, item: { id: string; title?: string | null }): boolean {
  if (text.includes(item.id)) return true;
  const title = stems(item.title ?? "");
  if (!title.size) return false;
  const said = stems(text);
  const shared = [...title].filter((stem) => said.has(stem)).length;
  return shared >= Math.min(2, title.size);
}

/** Чужие карточки и документы, названные владельцем в этом сообщении. */
export function ownerNamedItems(text: string, ownTaskId: string): { tasks: Array<{ id: string; title: string }>; notes: Array<{ id: string; title: string }> } {
  const tasks = db.prepare("SELECT id, title FROM tasks WHERE id != ? AND archived_at IS NULL ORDER BY rowid DESC LIMIT 3000").all(ownTaskId) as Array<{ id: string; title: string }>;
  const notes = db.prepare("SELECT id, title FROM user_notes WHERE title IS NOT NULL AND title != '' ORDER BY updated_at DESC LIMIT 3000").all() as Array<{ id: string; title: string }>;
  return {
    tasks: tasks.filter((item) => ownerNamed(text, item)).slice(0, 5),
    notes: notes.filter((item) => ownerNamed(text, item)).slice(0, 5),
  };
}

/** Текст сообщения, на которое отвечает роль, если его написал человек. */
export function ownerMessageText(messageId?: string | null): string {
  if (!messageId) return "";
  const row = db
    .prepare("SELECT m.text FROM chat_messages m JOIN users u ON u.id = m.from_user_id WHERE m.id = ? AND u.type != 'ai'")
    .get(messageId) as { text: string } | undefined;
  return row?.text ?? "";
}

/**
 * Чат и слот теперь в разных сессиях, поэтому по кнопке «Продолжить» план и
 * разговор уходят в рабочий запуск явно. Иначе роль не помнила бы, о чём договорились.
 */
export function resolutionHandoff(messageId: string): string {
  const message = db
    .prepare("SELECT chat_id, recipient_subtask_id, reply_to_message_id FROM chat_messages WHERE id = ?")
    .get(messageId) as { chat_id: string; recipient_subtask_id: string | null; reply_to_message_id: string | null } | undefined;
  if (!message?.reply_to_message_id || !message.recipient_subtask_id) return "";
  const source = db.prepare("SELECT text, subtask_id FROM chat_messages WHERE id = ?").get(message.reply_to_message_id) as { text: string; subtask_id: string | null } | undefined;
  if (!source?.subtask_id || source.subtask_id !== message.recipient_subtask_id || !hasResolutionPlan(source.text)) return "";
  const talk = (db
    .prepare(
      `SELECT u.name, m.text FROM chat_messages m JOIN users u ON u.id = m.from_user_id
        WHERE m.chat_id = ? AND (m.recipient_subtask_id = ? OR m.subtask_id = ?) AND m.id != ?
        ORDER BY m.rowid DESC LIMIT 20`,
    )
    .all(message.chat_id, source.subtask_id, source.subtask_id, messageId) as Array<{ name: string | null; text: string }>).reverse();
  return [
    "Пока этап стоял, вы с владельцем обсудили его в чате задачи. Этого разговора нет в твоей рабочей истории, вот он. Действуй по согласованному плану.",
    ...talk.map((row) => `${row.name ?? "Участник"}: ${row.text}`),
  ].join("\n");
}
