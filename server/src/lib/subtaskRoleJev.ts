// Сценарий JEV «Роли для подзадач» (владелец 16.10.2026): какой роли отдать
// каждую подзадачу карточки при распараллеливании. Раньше это решал только
// эмбеддинг-классификатор (runtime/subtaskRoleFanout.ts): ближайшая по
// смыслу роль, а всё неуверенное молча оставалось текущему исполнителю.
//
// Один запрос на всю карточку: state — карточка и список её подзадач (JEV
// видит работу целиком, а не по строчке), по каждой подзадаче — свой
// choice из ВКЛЮЧЁННЫХ ролей с их описаниями из реестра. Плюс noul «эту
// подзадачу стоит отдать отдельной роли?»: мелкие личные пункты JEV
// оставит исполнителю карточки.
//
// Выключено, нет ключа, не ответил — пустой результат, и фанаут идёт
// прежней дорогой (эмбеддинги). Подзадача, по которой JEV не уверен, —
// тоже прежней дорогой.
import { skippedObservation, updateObservation } from "./contextObservability.js";
import { jevSkipReason, evaluateJev, jevSubtaskRoleConfig, type JevQuestion } from "./jev.js";
import { allRoles } from "../roleRouting.js";

export interface JevSubtaskRolePick {
  role: string;
  confidence: number;
  /** Вероятность, что подзадачу стоит отдать отдельной роли (noul). */
  separate: number;
}

export async function pickRolesForSubtasksByJev(
  card: { title: string; description: string | null },
  subtasks: Array<{ id: string; title: string }>,
): Promise<Map<string, JevSubtaskRolePick>> {
  const out = new Map<string, JevSubtaskRolePick>();
  const cfg = jevSubtaskRoleConfig();
  if (!cfg || subtasks.length === 0) {skippedObservation("subtaskRole",!cfg?jevSkipReason("subtaskRole"):"no_candidates");return out;}

  const roles = allRoles().filter((r) => r.enabled);
  if (roles.length < 2) {skippedObservation("subtaskRole","too_few_roles");return out;}
  const criteria: Record<string, string> = {};
  for (const r of roles) criteria[r.key] = `${r.title}: ${r.summary}`;

  const questions: Record<string, JevQuestion> = {};
  subtasks.forEach((s, i) => {
    questions[`role_${i}`] = {
      type: "choice",
      instructions: `Какой роли команды отдать подзадачу №${i + 1} «${s.title}»?`,
      criteria,
    };
    questions[`separate_${i}`] = {
      type: "noul",
      instructions: `Подзадача №${i + 1} «${s.title}» — самостоятельная работа для отдельного исполнителя, а не мелкий пункт, который сделает исполнитель всей карточки?`,
    };
  });

  const result = await evaluateJev(
    {
      card: {
        title: card.title,
        description: (card.description ?? "").slice(0, 6000),
      },
      subtasks: subtasks.map((s, i) => `${i + 1}. ${s.title}`),
    },
    questions,
    {scenario:"subtaskRole"},
  );
  if (!result) return out;

  subtasks.forEach((s, i) => {
    const role = result.answers[`role_${i}`];
    const sep = result.answers[`separate_${i}`];
    if (!role || role.type !== "choice" || !(role.choice in criteria)) return;
    if (
      typeof role.confidence !== "number" ||
      role.confidence < cfg.minConfidence
    )
      return;
    const separate =
      sep && sep.type === "noul" && typeof sep.noul === "number" ? sep.noul : 1;
    out.set(s.id, { role: role.choice, confidence: role.confidence, separate });
  });
  updateObservation(result.observationId,{reason:out.size?"selected":"low_confidence",inputCount:subtasks.length,outputCount:out.size,details:[...out].map(([id,p])=>`${id}: ${p.role}, уверенность ${p.confidence}, отдельно ${p.separate}`)});
  return out;
}
