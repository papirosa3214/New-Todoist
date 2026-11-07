// Черновик плана не обходит ручные подзадачи (владелец 19.10.2026: «не
// игнорировать ручные подзадачи, а черновик тупо на свои ставит»).
//
// Шаг черновика без привязки сопоставляется по смыслу со свободной ручной
// подзадачей и получает `source_subtask_id`. Дальше работает уже
// существующий выбор работы (planWorkSelection.workChoices): если
// формулировки различаются, владелец галочкой берёт свою или предложенную.
// Ручная подзадача, которой пары не нашлось, становится шагом основной роли —
// иначе после утверждения карточку ведёт план, и она остаётся ничьей.
import db from "../db.js";
import { ROLE_NAMES } from "../roleRouting.js";

type GraphNode = {
  slot_key: string;
  role_key: string;
  expected_result: string;
  source_subtask_id?: string | null;
  required?: boolean;
  output_artifact?: unknown;
  instructions?: string | null;
};
type GraphEdge = {
  from_slot_key: string;
  to_slot_key: string;
  start_condition: string;
  artifact_key: string | null;
};

/** Порог совпадения слов: ниже — пара случайная, шаг остаётся новым. */
export const MANUAL_MATCH_MIN = 0.25;

/** Грубая основа слова: регистр, только буквы и цифры, первые 5 знаков —
 *  русские окончания не мешают («компоненты» ↔ «компонентов»). */
function stems(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3)
      .map((w) => w.slice(0, 5)),
  );
}

export function matchScore(a: string, b: string): number {
  const x = stems(a),
    y = stems(b);
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / Math.min(x.size, y.size);
}

function primaryRole(taskId: string): string {
  const t = db
    .prepare(
      "SELECT assignee_id, owner_selected_role, machine_selected_role FROM tasks WHERE id=?",
    )
    .get(taskId) as
    | {
        assignee_id: string | null;
        owner_selected_role: string | null;
        machine_selected_role: string | null;
      }
    | undefined;
  const role = t?.assignee_id?.startsWith("role_")
    ? t.assignee_id.slice(5)
    : (t?.owner_selected_role ?? t?.machine_selected_role ?? null);
  return role && ROLE_NAMES.includes(role) ? role : "builder";
}

export function bindManualSubtasks<N extends GraphNode, E extends GraphEdge>(
  taskId: string,
  graph: { nodes: N[]; edges: E[] },
): { nodes: N[]; edges: E[] } {
  const taken = new Set(
    graph.nodes.map((n) => n.source_subtask_id).filter(Boolean) as string[],
  );
  const free = (
    db
      .prepare(
        "SELECT id, title FROM subtasks WHERE task_id=? AND done=0 AND collaboration_plan_id IS NULL ORDER BY position",
      )
      .all(taskId) as Array<{ id: string; title: string }>
  ).filter((s) => !taken.has(s.id));
  if (!free.length) return graph;

  // Жадно: сначала самые похожие пары.
  const pairs: Array<{ node: number; sub: number; score: number }> = [];
  graph.nodes.forEach((n, i) => {
    if (n.source_subtask_id) return;
    free.forEach((s, j) => {
      const score = matchScore(n.expected_result, s.title);
      if (score >= MANUAL_MATCH_MIN) pairs.push({ node: i, sub: j, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score);
  const nodes = graph.nodes.map((n) => ({ ...n }));
  const usedNode = new Set<number>(),
    usedSub = new Set<number>();
  for (const p of pairs) {
    if (usedNode.has(p.node) || usedSub.has(p.sub)) continue;
    usedNode.add(p.node);
    usedSub.add(p.sub);
    nodes[p.node].source_subtask_id = free[p.sub].id;
  }

  // Подзадача без пары — шаг основной роли. Проверка и Критик её ждут.
  const edges = [...graph.edges];
  const role = primaryRole(taskId);
  const keys = new Set(nodes.map((n) => n.slot_key));
  const checkers = nodes.filter(
    (n) => n.role_key === "qa" || n.role_key === "critic_verifier",
  );
  free.forEach((s, j) => {
    if (usedSub.has(j)) return;
    let key = `manual_${j + 1}`,
      k = 2;
    while (keys.has(key)) key = `manual_${j + 1}_${k++}`;
    keys.add(key);
    nodes.push({
      slot_key: key,
      role_key: role,
      required: true,
      expected_result: s.title.slice(0, 1000),
      output_artifact: null,
      source_subtask_id: s.id,
    } as unknown as N);
    for (const c of checkers)
      edges.push({
        from_slot_key: key,
        to_slot_key: c.slot_key,
        start_condition: "submitted",
        artifact_key: null,
      } as E);
  });
  return { nodes, edges };
}
