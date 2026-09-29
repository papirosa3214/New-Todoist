// Умная параллелизация (владелец 30.09.2026): «у нас всё завязано на
// подзадачах... если параллелится — распредели, распихай по ролям сразу».
// Смотрит на уже НАПИСАННЫЕ открытые подзадачи карточки (руками владельца
// или ролью по ходу работы — неважно), подбирает каждой роль тем же
// локальным эмбеддинг-классификатором, что уже есть у диспетчера
// (semanticEnrich.matchRoleForText — дёшево, без похода к большой модели),
// и группирует те, что явно отличаются от текущего единственного
// исполнителя, в ПРЕДЛОЖЕНИЕ плана. План — черновик, как любой другой: его
// узлы при approve ЗАЙМУТ те же строки подзадач (source_subtask_id,
// migrations.ts 079), а не создадут рядом дубли — ровно тот кусок, из-за
// которого «фиктивные подзадачи» владельца бесили: тут ничего не
// плодится, существующая строка просто получает исполнителя.
//
// Осознанно НЕ автоматика: вызывается явным действием владельца/
// оркестратора (POST .../suggest-from-subtasks), не фоновым таймером и не
// на каждое сохранение подзадачи. Причина — README каталога шаблонов
// (docs/2026-09-29-collaboration-plan-templates/README.md, п.9): «числовые
// пороги подбора задаются только после калибровки на реальных задачах» —
// FANOUT_CONFIDENCE ниже не калиброван, и молчаливый автозапуск на
// неоткалиброванном пороге завёл бы столько же спама, сколько сегодняшний
// баг с draft-планом, который никто не звал.
import db from "../db.js";
import { matchRoleForText } from "../lib/semanticEnrich.js";
import { ROLE_NAMES } from "../roleRouting.js";

/** Минимальный косинус, чтобы считать подбор роли для подзадачи уверенным.
 *  Не откалибровано на реальных задачах — см. комментарий выше. Поднять
 *  порог, если в проде фанаут будет слишком охотно тащить очевидно личные
 *  мелкие пункты в отдельные роли; опустить — если наоборот игнорирует
 *  подзадачи, которые владелец сам бы отдал другой роли. */
export const FANOUT_CONFIDENCE = (() => {
  const raw = process.env.SUBTASK_FANOUT_CONFIDENCE;
  const parsed = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.35;
})();

export type FanoutSuggestion =
  | { suggested: false; reason: string }
  | {
      suggested: true;
      rationale: string;
      nodes: Array<{ slot_key: string; role_key: string; expected_result: string; source_subtask_id: string }>;
    };

function primaryRole(task: { assignee_id: string | null; machine_selected_role: string | null; owner_selected_role: string | null }): string | null {
  if (task.assignee_id?.startsWith("role_")) return task.assignee_id.slice("role_".length);
  return task.owner_selected_role ?? task.machine_selected_role ?? null;
}

/** Уникальный slot_key из заголовка подзадачи: role_key + счётчик, если
 *  роль уже встречалась — совпадать по буквам с заголовком не обязано, это
 *  внутренний ключ графа, не то, что видит владелец (видит expected_result). */
function slotKeyFor(role: string, index: number, used: Set<string>): string {
  const base = `${role}_${index + 1}`;
  let key = base;
  let n = 2;
  while (used.has(key)) key = `${base}_${n++}`;
  used.add(key);
  return key;
}

export async function suggestFanoutFromSubtasks(taskId: string): Promise<FanoutSuggestion> {
  const task = db
    .prepare("SELECT assignee_id, machine_selected_role, owner_selected_role FROM tasks WHERE id = ?")
    .get(taskId) as { assignee_id: string | null; machine_selected_role: string | null; owner_selected_role: string | null } | undefined;
  if (!task) return { suggested: false, reason: "карточка не найдена" };

  const openSubtasks = db
    .prepare("SELECT id, title FROM subtasks WHERE task_id = ? AND done = 0 AND collaboration_plan_id IS NULL ORDER BY position")
    .all(taskId) as Array<{ id: string; title: string }>;
  if (openSubtasks.length < 2) {
    return { suggested: false, reason: "меньше двух открытых подзадач — распараллеливать нечего, справится текущий исполнитель" };
  }

  const primary = primaryRole(task);
  const used = new Set<string>();
  const nodes: Array<{ slot_key: string; role_key: string; expected_result: string; source_subtask_id: string }> = [];

  for (const subtask of openSubtasks) {
    const { matched } = await matchRoleForText(subtask.title, { topK: 1 });
    const top = matched[0];
    if (!top || top.score < FANOUT_CONFIDENCE) continue; // неуверенно — оставить как есть, текущий исполнитель сделает сам
    if (!ROLE_NAMES.includes(top.role)) continue; // роль сейчас выключена — не назначать на неё узел
    if (top.role === primary) continue; // та же роль, что и так уже ведёт карточку — не парал­лелизм, а шум

    nodes.push({
      slot_key: slotKeyFor(top.role, nodes.length, used),
      role_key: top.role,
      expected_result: subtask.title,
      source_subtask_id: subtask.id,
    });
  }

  if (nodes.length < 1) {
    return { suggested: false, reason: "все открытые подзадачи уверенно совпали с текущим исполнителем или не распознались — параллелить некого" };
  }

  const roles = [...new Set(nodes.map((n) => n.role_key))];
  return {
    suggested: true,
    rationale: `Подзадачи распознаны по ${roles.length > 1 ? "ролям: " + roles.join(", ") : "роли " + roles[0]} — предложены как параллельные узлы плана вместо линейной работы одного исполнителя.`,
    nodes,
  };
}
