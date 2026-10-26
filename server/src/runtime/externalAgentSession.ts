// Выбор адаптера внешнего агента по каталогу (lib/externalAgents.ts):
// Claude Code — stream-json по подписке, остальные — по ACP.
import { knownAgent } from "../lib/externalAgents.js";
import { createAcpAgentSession } from "./acpAgentSession.js";
import { createCliAgentSession, type CliAgentSession, type CliSessionInput } from "./cliAgentSession.js";

export function createExternalAgentSession(runtime: string, input: CliSessionInput): Promise<CliAgentSession> {
  const agent = knownAgent(runtime);
  if (agent?.adapter === "acp") return createAcpAgentSession({ ...input, args: agent.acpArgs ?? [] });
  if (agent?.adapter === "claude-stream-json") return createCliAgentSession(input);
  return Promise.reject(new Error(`для внешнего агента «${agent?.title ?? runtime}» нет адаптера`));
}
