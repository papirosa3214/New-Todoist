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
import { pickRolesForSubtasksByJev } from "../lib/subtaskRoleJev.js";

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
      edges: Array<{ from_slot_key: string; to_slot_key: string; start_condition: "submitted" }>;
    };

/** Этап узла в плане: сначала работа, потом проверка, Критик последним. */
function stageOf(role: string): number {
  if (role === "critic_verifier") return 2;
  if (role === "qa") return 1;
  return 0;
}

/** Связи по этапам: каждый узел этапа ждёт все узлы ближайшего предыдущего
 *  непустого этапа. Внутри этапа — параллельно. Без связей проверка и
 *  Критик стартовали сразу, не дожидаясь разработки (владелец 19.10.2026). */
export function stageEdges(nodes: Array<{ slot_key: string; role_key: string }>) {
  const stages = [0, 1, 2].map((st) => nodes.filter((n) => stageOf(n.role_key) === st)).filter((g) => g.length);
  const edges: Array<{ from_slot_key: string; to_slot_key: string; start_condition: "submitted" }> = [];
  for (let i = 1; i < stages.length; i++) {
    for (const to of stages[i]) for (const from of stages[i - 1]) {
      edges.push({ from_slot_key: from.slot_key, to_slot_key: to.slot_key, start_condition: "submitted" });
    }
  }
  return edges;
}

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
    .prepare("SELECT title, description, assignee_id, machine_selected_role, owner_selected_role FROM tasks WHERE id = ?")
    .get(taskId) as { title: string; description: string | null; assignee_id: string | null; machine_selected_role: string | null; owner_selected_role: string | null } | undefined;
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

  // BGE — первый, локальный и уже откалиброванный путь. JEV вызываем лишь
  // для подзадач, которым BGE не смог уверенно подобрать роль.
  const localPicks = new Map<string, { role: string; score: number }>();
  for (const subtask of openSubtasks) {
    const { matched } = await matchRoleForText(subtask.title, { topK: 1 });
    if (matched[0] && matched[0].score >= FANOUT_CONFIDENCE) localPicks.set(subtask.id, matched[0]);
  }
  const unresolved = openSubtasks.filter((subtask) => !localPicks.has(subtask.id));
  const jevPicks = unresolved.length
    ? await pickRolesForSubtasksByJev(task, unresolved).catch(() => new Map())
    : new Map();
  let byJev = 0;

  for (const subtask of openSubtasks) {
    const local = localPicks.get(subtask.id);
    const jev = jevPicks.get(subtask.id);
    let top: { role: string; score: number } | undefined;
    // Подзадача, которую раньше оставляли «текущему исполнителю» (мелкий
    // пункт, неуверенный подбор, та же роль), теперь становится узлом
    // основной роли. После утверждения карточку ведёт план, и подзадача вне
    // плана оставалась ничьей: 19.10.2026 из пяти подзадач план взял две,
    // три разработческие повисли (владелец: «болтаются, хуй по никак»).
    if (local) {
      top = local;
    } else if (jev) {
      top = jev.separate < 0.5 && primary ? { role: primary, score: 1 } : { role: jev.role, score: jev.confidence };
    } else {
      top = primary ? { role: primary, score: 0 } : undefined;
      if (!top) continue; // нет ни уверенной роли, ни основной — оставить как есть
    }
    if (!ROLE_NAMES.includes(top.role)) continue; // роль сейчас выключена — не назначать на неё узел

    if (jev) byJev++;
    nodes.push({
      slot_key: slotKeyFor(top.role, nodes.length, used),
      role_key: top.role,
      expected_result: subtask.title,
      source_subtask_id: subtask.id,
    });
  }

  // Все узлы — одна основная роль: распределять не на кого, план не нужен.
  if (nodes.length < 1 || nodes.every((n) => n.role_key === primary)) {
    return { suggested: false, reason: "все открытые подзадачи уверенно совпали с текущим исполнителем или не распознались — параллелить некого" };
  }

  const roles = [...new Set(nodes.map((n) => n.role_key))];
  return {
    suggested: true,
    rationale: `Подзадачи распознаны по ${roles.length > 1 ? "ролям: " + roles.join(", ") : "роли " + roles[0]} — предложены как параллельные узлы плана вместо линейной работы одного исполнителя.${byJev ? ` Роли подобраны JEV: ${byJev} из ${nodes.length}.` : ""}`,
    nodes,
    edges: stageEdges(nodes),
  };
}
