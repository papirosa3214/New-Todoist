// Общие константы для тестов моста dispatch (карточка 5ceda583).
//
// Не держим копию 8-ролевого списка в тестах: импорт из roleRouting.ts —
// единственный источник правды. ID Pi Agent — общий с roleRouting.ts,
// чтобы любой «не тот Pi» сразу был виден тесту как чужой исполнитель.
import { ROLE_NAMES, type RoleName } from "../../src/roleRouting.js";

export { ROLE_NAMES };
export type { RoleName };

export const PI_AGENT_ID = "1fa09a0a-0c41-4e7e-982a-a1c46570e5d2";
