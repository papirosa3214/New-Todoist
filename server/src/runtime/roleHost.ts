// Машина, на которой выполняется роль (правка 2 плана taskflow-mac-host).
//
// Одно правило решает всё остальное: host_id === null означает «как раньше»,
// то есть .110. Роль без явно назначенной машины не меняет поведение ни на
// строчку — иначе появление колонки сломало бы работающие задачи.
//
// Два источника назначения, в этом порядке:
//
//   1. слот (окно плана)   — точнее всего: конкретный шаг конкретного плана;
//   2. подзадача           — назначение на саму задачу.
//
// Если слот молчит, берётся назначение подзадачи, а если и оно молчит —
// машина не назначена вовсе. Наследование «от задачи к слоту» осознанно НЕ
// читается здесь: оно принадлежит слою, который ставит слоты (правка 9), и
// молча дублировало бы решение в двух местах.
//
// Молчаливого отката нет намеренно. Машина назначена, но офлайн — это ошибка
// словами («машина «mac» сейчас офлайн»), а не тихий переезд на .110: тихий
// переезд означал бы, что результат работы окажется не там, куда его ждали.
import db from "../db.js";
import { isMachineOnline, resolveMachine } from "../host/gateway.js";

function subtaskHost(subtaskId: string): string | null {
  const row = db
    .prepare("SELECT host_id FROM subtasks WHERE id = ? LIMIT 1")
    .get(subtaskId) as { host_id?: string | null } | undefined;
  return row?.host_id ?? null;
}

/**
 * Машина роли или null, если назначения нет.
 *
 * Отдельной таблицы слотов в TaskFlow нет: «слот» — это подзадача с
 * plan_node_key, поэтому одного чтения достаточно. Наследование «от задачи к
 * подзадаче» здесь НЕ читается — оно принадлежит слою, который ставит слоты
 * (правка 9), и молча дублировало бы решение в двух местах.
 */
export function resolveRoleHost(taskId: string, subtaskId?: string | null): string | null {
  const отПодзадачи = subtaskId ? subtaskHost(subtaskId) : null;
  if (отПодзадачи) return отПодзадачи;
  return taskHost(taskId);
}

/** Назначение машины на уровне задачи — задел на правку 9. */
function taskHost(taskId: string): string | null {
  const row = db
    .prepare("SELECT host_id FROM subtasks WHERE task_id = ? AND host_id IS NOT NULL LIMIT 1")
    .get(taskId) as { host_id?: string | null } | undefined;
  return row?.host_id ?? null;
}

/**
 * Человеческое объяснение, почему роль не может идти на машину.
 * null значит «всё в порядке, можно выполнять».
 */
export function roleHostError(machineId: string): string | null {
  const машина = resolveMachine(machineId);
  if (!машина) return `машина ${machineId} не заведена в реестре`;
  if (машина.revoked_at) return `ключ машины «${машина.name}» отозван`;
  if (!isMachineOnline(machineId)) {
    return `машина «${машина.name}» сейчас офлайн — подключите её и повторите`;
  }
  return null;
}

/** Проект задачи — нужен обеим ветвям, чтобы найти папку. */
export function taskProjectId(taskId: string): string | null {
  const row = db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(taskId) as
    | { project_id?: string | null }
    | undefined;
  return row?.project_id ?? null;
}