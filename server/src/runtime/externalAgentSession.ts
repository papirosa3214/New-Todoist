// Выбор адаптера внешнего агента по каталогу (lib/externalAgents.ts):
// Claude Code — stream-json по подписке, остальные — по ACP.
//
// Операции TaskFlow агент получает одним набором — инструментами MCP-сервера
// `taskflow_run` (scripts/run-mcp-bridge.mjs): фабрика регистрирует операции
// запуска (runtime/runToolRegistry.ts) и снимает регистрацию при dispose.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { knownAgent } from "../lib/externalAgents.js";
import { createAcpAgentSession } from "./acpAgentSession.js";
import { createCliAgentSession, type CliAgentSession, type CliSessionInput } from "./cliAgentSession.js";
import { registerRunTools, type RunTool } from "./runToolRegistry.js";

const BRIDGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/run-mcp-bridge.mjs");
export const RUN_MCP_SERVER = "taskflow_run";

export interface ExternalRunTools {
  runId: string;
  /** Учётка участника, которому выдан запуск. */
  userId: string;
  /** Пропуск участника (JWT) — им мост ходит на сервер. */
  token: string;
  tools: RunTool[];
}

function bridgeEnv(run: ExternalRunTools): Record<string, string> {
  return {
    TASKFLOW_API: process.env.TASKFLOW_API || `http://127.0.0.1:${process.env.PORT || 3001}`,
    TASKFLOW_RUN_ID: run.runId,
    TASKFLOW_TOKEN: run.token,
  };
}

export async function createExternalAgentSession(
  runtime: string,
  input: CliSessionInput & { runTools?: ExternalRunTools },
): Promise<CliAgentSession> {
  const agent = knownAgent(runtime);
  if (agent?.adapter !== "acp" && agent?.adapter !== "claude-stream-json")
    throw new Error(`для внешнего агента «${agent?.title ?? runtime}» нет адаптера`);
  const { runTools, ...rest } = input;
  const unregister = runTools ? registerRunTools(runTools.runId, runTools.userId, runTools.tools) : () => {};
  try {
    const env = runTools ? bridgeEnv(runTools) : null;
    const session =
      agent.adapter === "acp"
        ? await createAcpAgentSession({
            ...rest,
            args: agent.acpArgs ?? [],
            mcpServers: env
              ? [{ name: RUN_MCP_SERVER, command: process.execPath, args: [BRIDGE], env: Object.entries(env).map(([name, value]) => ({ name, value })) }]
              : [],
          })
        : await createCliAgentSession({
            ...rest,
            mcpConfig: env
              ? JSON.stringify({ mcpServers: { [RUN_MCP_SERVER]: { type: "stdio", command: process.execPath, args: [BRIDGE], env } } })
              : undefined,
          });
    const dispose = session.dispose.bind(session);
    session.dispose = () => {
      unregister();
      dispose();
    };
    return session;
  } catch (error) {
    unregister();
    throw error;
  }
}
