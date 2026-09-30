import { instructionResources } from "./instructionResources.js";
import { composeLayer, LAYER_CATALOG, instructionManifest } from "../lib/roleContextResolver.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROLE_NAMES, roleUserId } from "../roleRouting.js";

/**
 * Доступ роли к трекеру на время одного запуска (владелец 23.09.2026:
 * «рантайм — часть TaskFlow, зачем ему ключи»).
 *
 * Раньше у каждой роли был постоянный ключ в хранилище, строка в запуске
 * будильника и свой файл подключения. Теперь запуск делает сам сервер: он
 * подписывает пропуск роли тем же механизмом, что вход в веб (JWT, срок
 * ограничен), и кладёт временный файл подключения к `mcp_server.py` —
 * тот берёт пропуск из TASKFLOW_TOKEN, в хранилище не ходит. Файл живёт,
 * пока идёт запуск, и удаляется при завершении. Новой роли не нужно ничего
 * заводить руками.
 */

type Signer = (payload: { id: string }, options: { expiresIn: string }) => string;
let signer: Signer | null = null;

/** Подключается при старте сервера (index.ts) — после регистрации JWT. */
export function setRoleTokenSigner(fn: Signer): void {
  signer = fn;
}

const PROFILES_DIR = path.join(os.homedir(), ".pi", "agent", "taskflow-profiles");
const RUNS_DIR = process.env.TASKFLOW_RUNS_DIR || path.join(os.tmpdir(), "taskflow-runs");
const MCP_SERVER = path.join(process.cwd(), "scripts", "mcp_server.py");
const DEFAULT_TOOLS = "taskflow_my_tasks,taskflow_task,taskflow_claim,taskflow_heartbeat,taskflow_state,taskflow_comment,taskflow_subtask_done,taskflow_subtask_add,taskflow_rules,taskflow_status,taskflow_agents,taskflow_chat_send,taskflow_chat_typing,taskflow_chat_read,taskflow_subtask_work,taskflow_projects,taskflow_project_tasks,taskflow_create_project,taskflow_create_task,taskflow_suggest_subtasks,taskflow_structure_dictation,taskflow_my_stats,taskflow_docs,taskflow_doc_read,taskflow_doc_write,taskflow_kb_search,taskflow_runtime";

/** Набор инструментов роли — из её прежнего профиля, если он есть; у новой
 *  роли профиля нет — стандартный набор исполнителя. */
function roleTools(role: string): string {
  try {
    const profile = JSON.parse(
      fs.readFileSync(path.join(PROFILES_DIR, `${role}.json`), "utf8"),
    ) as { mcpServers?: { taskflow?: { env?: Record<string, string> } } };
    const tools = profile.mcpServers?.taskflow?.env?.TASKFLOW_MCP_TOOLS;
    if (tools && tools.trim()) return withChatTools(tools);
  } catch {
    // профиля нет — новая роль
  }
  return withChatTools(DEFAULT_TOOLS);
}

/** Инструменты для ответов в чате — есть у каждой роли, даже если её
 *  профиль задаёт свой список: без них виджет погоды пришлось бы
 *  выдумывать (владелец 01.10.2026). */
const CHAT_TOOLS = ["taskflow_weather", "taskflow_plan_request", "taskflow_consult"];

function withChatTools(list: string): string {
  const names = list.split(",").map((n) => n.trim()).filter(Boolean);
  for (const tool of CHAT_TOOLS) if (!names.includes(tool)) names.push(tool);
  return names.join(",");
}

/** Выдать запуску доступ роли. Возвращает путь к временному файлу
 *  подключения для `pi --mcp-config`; null — роль не из списка или
 *  подпись ещё не подключена (тогда запуск идёт без инструментов трекера). */
export function prepareRoleRunAccess(runId: string, role: string): string | null {
  if (!signer || !ROLE_NAMES.includes(role)) return null;
  const token = signer({ id: roleUserId(role) }, { expiresIn: "12h" });
  fs.mkdirSync(RUNS_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(RUNS_DIR, `${runId}.json`);
  instructionResources();
  const snapshot = file + ".instructions.json";
  fs.writeFileSync(snapshot, JSON.stringify({role,manifest:instructionManifest(role,"chat"),texts:Object.fromEntries(LAYER_CATALOG.filter(s=>s.key.startsWith("tool.mcp.")||s.key==="mcp.initialize").map(s=>[s.key,composeLayer(role,s.key)!.effective]))}),{mode:0o600});
  const config = {
    mcpServers: {
      taskflow: {
        command: "/usr/bin/python3",
        args: [MCP_SERVER],
        env: {
          TASKFLOW_TOKEN: token,
          TASKFLOW_MCP_ROLE: role,
          TASKFLOW_INSTRUCTION_SNAPSHOT: snapshot,
          TASKFLOW_MCP_TOOLS: roleTools(role),
        },
        directTools: true,
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return file;
}

/** Убрать доступ по завершении запуска. */
export function releaseRoleRunAccess(file: string | null | undefined): void {
  if (!file) return;
  try {
    fs.rmSync(file+".skills",{recursive:true,force:true});
    fs.unlinkSync(file);
    for (const suffix of [".instructions.json", ".prompt.txt", ".system.txt", ".tools.mjs"]) { try { fs.unlinkSync(file+suffix); } catch {} }
  } catch {
    // уже удалён
  }
}
