import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createCodingTools,
  createReadOnlyTools,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { roleBashKillError } from "./roleBashGuard.js";
import { chatTurnSystemText, installSecretarySystem } from "./secretaryChatPrompt.js";
import { secretaryThings3Tools } from "./secretaryThings3Tools.js";
import { connectRoleMcp } from "./graftMcp.js";
import { connectRoleComposio } from "./composioRuntime.js";
import { composeLayer } from "../lib/roleContextResolver.js";
import { chatSystemPrompt, createTaskResourceLoader } from "./instructionResources.js";
import { ensureRoleHome } from "./roleHome.js";
import { runAsSubagent } from "./roleSubagentCall.js";
import {
  buildRoleToolCatalog,
  installNativeToolCore,
  installNativeToolSchemas,
  roleToolInstruction,
} from "./roleToolCatalog.js";

/**
 * Профиль Помощника для обычной сессии владельца (владелец 12.11.2026: «из
 * помощника делать не роль, а просто обычные сессии, чтобы механика была как
 * у тебя или GPT-чата — без всяких очередей»).
 *
 * Берём у Помощника то, что делает его Помощником: инструкцию, навыки и
 * инструменты (задачи, рутины, Things 3, база знаний, память, MCP). Не берём
 * то, что делало его ролью в комнате: очередь доставок, замок «одна роль —
 * один ход», 30-минутный предел и замер процента контекста. Сессия живёт
 * своим Pi-циклом: ответ стримится, сообщение во время ответа — `steer`,
 * переполнение контекста Pi сжимает сам.
 */
export interface OwnerSessionProfile {
  resourceLoader: unknown;
  toolNames: string[];
  customTools: ToolDefinition[];
  /** Ставится на созданную сессию: системная инструкция, схемы и ядро инструментов. */
  install(session: unknown): void;
  dispose(): Promise<void>;
}

const ASSISTANT_ROLE = "secretary";

/** Готовые расширения Pi для сессии Помощника (владелец 13.11.2026: «зачем
 *  самописное, когда есть готовое»). Только те, что имеют смысл в сессии:
 *  hesitation-gate (не буксовать — спросить владельца кнопками) и
 *  verify-before-claim (проверить, прежде чем утверждать). subagent,
 *  taskflow-activity, taskflow-todo-mirror, orca-agent-status — для
 *  терминального Pi и карточек, сюда не идут. Субагентам-ролям — без них. */
const SESSION_PI_EXTENSIONS = ["hesitation-gate.ts", "verify-before-claim.ts"]
  .map((name) => path.join(os.homedir(), ".pi", "agent", "extensions", name));
const ASSISTANT_MODE = "work";

export async function ownerAssistantProfile(sessionId: string, role: string = ASSISTANT_ROLE): Promise<OwnerSessionProfile> {
  const ASSISTANT_ROLE_FOR_SESSION = role;
  const home = ensureRoleHome(ASSISTANT_ROLE_FOR_SESSION);
  const cwd = home.workspace;
  const systemPrompt = chatTurnSystemText(
    ASSISTANT_ROLE_FOR_SESSION,
    await chatSystemPrompt(ASSISTANT_ROLE_FOR_SESSION, ASSISTANT_MODE, cwd, undefined, "session"),
    [roleToolInstruction()],
  );
  const resourceLoader = await createTaskResourceLoader(ASSISTANT_ROLE_FOR_SESSION, cwd, systemPrompt, undefined, true,
    ASSISTANT_ROLE_FOR_SESSION === ASSISTANT_ROLE ? SESSION_PI_EXTENSIONS.filter((file) => fs.existsSync(file)) : []);
  const none = { tools: [] as any[], close: async () => {} };
  const composio = await connectRoleComposio(ASSISTANT_ROLE_FOR_SESSION, ASSISTANT_MODE, sessionId).catch((error) => {
    console.warn("[owner-sessions] Composio Помощника не подключился:", error);
    return none;
  });
  const infra = await connectRoleMcp(ASSISTANT_ROLE_FOR_SESSION, cwd).catch(() => none);

  const builtin = [
    ...new Map([...createCodingTools(cwd), ...createReadOnlyTools(cwd)].map((tool) => [tool.name, tool])).values(),
  ].map((tool: any) => ({
    ...tool,
    description: composeLayer(ASSISTANT_ROLE_FOR_SESSION, "tool.builtin." + tool.name)?.effective ?? tool.description,
    ...(tool.name === "bash"
      ? {
          // Bash исполняется от пользователя сервера: остановка сервера по
          // шаблону уронила бы его — отказ до запуска, как в ходе чата.
          execute: async (id: string, args: any, signal?: AbortSignal, onUpdate?: any) => {
            const killError = roleBashKillError(args?.command);
            if (killError) throw new Error(killError);
            return tool.execute(id, args, signal, onUpdate);
          },
        }
      : {}),
  }));
  // Вызова роли через чат (taskflow_call_role и спутники) в сессиях нет:
  // субагент сессии и есть роль — taskflow_spawn_session с role (владелец
  // 13.11.2026). Каталог собирается «как у субагента» — тогда этих
  // инструментов в нём нет с самого начала.
  const catalog = runAsSubagent({ requesterRole: "owner", recipientRole: ASSISTANT_ROLE_FOR_SESSION }, () => buildRoleToolCatalog(
    { role: ASSISTANT_ROLE_FOR_SESSION, mode: ASSISTANT_MODE, runId: sessionId, ownerSession: true },
    [...composio.tools, ...infra.tools,
      ...(ASSISTANT_ROLE_FOR_SESSION === ASSISTANT_ROLE ? secretaryThings3Tools({ role: ASSISTANT_ROLE_FOR_SESSION }) : [])],
  ));

  return {
    resourceLoader,
    toolNames: [...builtin.map((tool) => tool.name), ...catalog.registeredNames],
    customTools: [...builtin, ...catalog.customTools] as ToolDefinition[],
    install(session: unknown) {
      installSecretarySystem(session, ASSISTANT_ROLE_FOR_SESSION, systemPrompt);
      installNativeToolSchemas(session, catalog);
      installNativeToolCore(session, catalog, builtin.map((tool) => tool.name));
    },
    async dispose() {
      (resourceLoader as { disposeResources?: () => void }).disposeResources?.();
      await Promise.allSettled([composio.close(), infra.close()]);
    },
  };
}
