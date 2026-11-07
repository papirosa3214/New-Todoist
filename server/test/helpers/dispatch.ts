// Общие константы для тестов моста dispatch (карточка 5ceda583).
//
// Не держим копию 8-ролевого списка в тестах: импорт из roleRouting.ts —
// единственный источник правды. ID Pi Agent — общий с roleRouting.ts,
// чтобы любой «не тот Pi» сразу был виден тесту как чужой исполнитель.
//
// ROLE_USER_IDS — это «зеркало» таблицы в routes/dispatch.ts: assignee_id
// после dispatch и notifications/inbox пишутся на ту же role-учётку.
// Копия здесь, потому что const в dispatch.ts не экспортирован, а тесты
// должны сравнивать «задача ушла на учётку выбранной роли», не угадывая
// id руками. Если в dispatch.ts поменяется мэппинг — синхронизировать тут.
import { ROLE_NAMES, type RoleName } from "../../src/roleRouting.js";

export { ROLE_NAMES };
export type { RoleName };

export const PI_AGENT_ID = "1fa09a0a-0c41-4e7e-982a-a1c46570e5d2";

export const ROLE_USER_IDS: Record<RoleName, string> = {
  researcher: "role_researcher",
  analyst: "role_analyst",
  critic_verifier: "role_critic_verifier",
  architect: "role_architect",
  builder: "role_builder",
  qa: "role_qa",
  designer: "role_designer",
};
