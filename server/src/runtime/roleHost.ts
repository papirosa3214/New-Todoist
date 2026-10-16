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
import fs from "node:fs";
import db from "../db.js";
import { HOSTS_CONFIG, hostRepoPath } from "./roleWorkspace.js";
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
export function resolveRoleHost(taskId: string, subtaskId?: string | null, role?: string): string | null {
  const отПодзадачи = subtaskId ? subtaskHost(subtaskId) : null;
  if (отПодзадачи) return отПодзадачи;
  return taskHost(taskId) ?? (role ? roleDefaultHost(taskId, role) : null) ?? projectDefaultHost(taskId);
}

/**
 * Машина роли по умолчанию (roleDefaults в task-context-hosts.json): разработчик
 * iOS-клиента собирает на маке через хоста, а не в отдельной копии через
 * ssh-шлюз (владелец 15.10.2026). Только если у проекта задачи на этой машине
 * есть путь — иначе роль, как и раньше, работает на .110.
 */
function roleDefaultHost(taskId: string, role: string): string | null {
  try {
    const конфиг = JSON.parse(fs.readFileSync(HOSTS_CONFIG, "utf8")) as { roleDefaults?: Record<string, unknown> };
    const машина = конфиг.roleDefaults?.[role];
    return typeof машина === "string" && hostRepoPath(taskId, машина, false) ? машина : null;
  } catch {
    return null;
  }
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
/** Любая роль работает на машине проекта; никакого согласования плана здесь нет. */
function projectDefaultHost(taskId:string):string|null {
 try {
  const config=JSON.parse(fs.readFileSync(HOSTS_CONFIG,"utf8")).projects??{};
  const machines=Object.keys(config).filter(id=>hostRepoPath(taskId,id,false));
  if(machines.length>1)throw new Error("У проекта несколько машин: назначь нужную явно");
  return machines[0]??null;
 }catch(error){if(error instanceof SyntaxError || (error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
}
