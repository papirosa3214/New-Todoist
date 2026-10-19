// Сессия внешнего агента Claude Code с той же поверхностью, что у сессии Pi
// (subscribe / prompt / steer / abort / dispose / state.messages), — чтобы
// runRoleInProcess, live-ход, сторож тишины и снимки слота работали без
// изменений. Роль переводится на внешнего агента записью модели
// `claude-code/<модель>` в role-routing (sonnet, opus, …).
//
// Ключей TaskFlow не хранит: CLI работает под своим логином на машине.
// Инструменты TaskFlow приходят через cliToolBridge (stdio-MCP), встроенные
// инструменты CLI (Bash, Read, Edit…) работают в cwd worktree карточки.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { BRIDGE_SERVER_NAME, startToolBridge, type BridgeTool, type ToolBridge } from "./cliToolBridge.js";

export const CLI_PROVIDER = "claude-code";

/** Встроенные инструменты Claude Code → имена Pi (их понимают live-ход и журнал активности). */
const BUILTIN_NAMES: Record<string, string> = {
  Bash: "bash", Read: "read", Edit: "edit", MultiEdit: "edit", Write: "write", Grep: "grep", Glob: "find", LS: "ls",
};
const MCP_PREFIX = `mcp__${BRIDGE_SERVER_NAME}__`;

export function piToolName(name: string): string {
  if (name.startsWith(MCP_PREFIX)) return name.slice(MCP_PREFIX.length);
  return BUILTIN_NAMES[name] ?? name;
}

type Listener = (event: any) => void;

/** Окружение CLI без чужих ключей: ANTHROPIC_* у сервера — для Pi, и CLI с ними
 *  ушёл бы на оплату по ключу вместо своего входа (или в «Not logged in»). */
export function cliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$)/.test(k)));
}

export interface CliSessionInput {
  cwd: string;
  /** Модель для `--model` (alias вроде sonnet или полное имя). */
  model: string;
  systemPrompt: string;
  tools: BridgeTool[];
  /** Для тестов: другой бинарник. */
  command?: string;
}

export interface CliAgentSession {
  readonly systemPrompt: string;
  readonly thinkingLevel: "off";
  readonly state: { messages: any[] };
  readonly sessionId: string | null;
  subscribe(listener: Listener): () => void;
  prompt(text: string): Promise<void>;
  steer(text: string): void;
  abort(): Promise<void>;
  dispose(): void;
}

/** Переводчик одной строки stream-json в события Pi. Отдельно — чтобы проверять без процесса. */
export class StreamJsonTranslator {
  sessionId: string | null = null;
  result: { isError: boolean; text: string } | null = null;
  private partialText = false;
  private partialThinking = false;

  constructor(private readonly emit: (event: any) => void) {}

  line(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "system" && msg.subtype === "init" && typeof msg.session_id === "string") {
      this.sessionId = msg.session_id;
      return;
    }
    if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev?.type === "content_block_start" && ev.content_block?.type === "thinking") {
        this.partialThinking = true;
        this.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } });
      } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        this.partialText = true;
        this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: ev.delta.text ?? "" } });
      } else if (ev?.type === "content_block_delta" && ev.delta?.type === "thinking_delta") {
        this.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: ev.delta.thinking ?? "" } });
      } else if (ev?.type === "content_block_stop" && this.partialThinking) {
        this.partialThinking = false;
        this.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } });
      }
      return;
    }
    if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
      const content: any[] = [];
      for (const block of msg.message.content) {
        if (block?.type === "text") {
          content.push({ type: "text", text: block.text ?? "" });
          // Без частичных сообщений текст приходит только целиком.
          if (!this.partialText) this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: block.text ?? "" } });
        } else if (block?.type === "thinking") {
          content.push({ type: "thinking", thinking: block.thinking ?? "" });
        } else if (block?.type === "tool_use") {
          this.emit({ type: "tool_execution_start", toolCallId: block.id, toolName: piToolName(String(block.name)), args: block.input ?? {} });
        }
      }
      this.partialText = false;
      if (content.length) this.emit({ type: "message_end", message: { role: "assistant", content } });
      return;
    }
    if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block?.type === "tool_result") {
          this.emit({ type: "tool_execution_end", toolCallId: block.tool_use_id, isError: block.is_error === true });
        }
      }
      return;
    }
    if (msg.type === "result") {
      const isError = msg.is_error === true || (typeof msg.subtype === "string" && msg.subtype.startsWith("error"));
      const text = typeof msg.result === "string" ? msg.result : Array.isArray(msg.errors) ? msg.errors.join("; ") : String(msg.subtype ?? "");
      this.result = { isError, text };
    }
  }
}

export async function createCliAgentSession(input: CliSessionInput): Promise<CliAgentSession> {
  const bridge: ToolBridge = await startToolBridge(input.tools);
  const listeners = new Set<Listener>();
  const messages: any[] = [];
  let sessionId: string | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  let aborted = false;
  let disposed = false;
  const emit = (event: any) => { for (const l of listeners) { try { l(event); } catch { /* слушатель не роняет ход */ } } };
  const userLine = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";

  const session: CliAgentSession = {
    systemPrompt: input.systemPrompt,
    thinkingLevel: "off",
    state: { messages },
    get sessionId() { return sessionId; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async prompt(text) {
      if (disposed) throw new Error("сессия внешнего агента закрыта");
      if (child) throw new Error("внешний агент уже выполняет ход");
      aborted = false;
      messages.push({ role: "user", content: [{ type: "text", text }] });
      const args = [
        "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--model", input.model,
        "--append-system-prompt", input.systemPrompt,
        "--mcp-config", bridge.configPath, "--strict-mcp-config",
        // Роль на Pi тоже ходит без подтверждений; границы — worktree карточки и права учётки роли.
        "--permission-mode", "bypassPermissions",
      ];
      // Следующий prompt той же сессии (например, резюме при остановке) продолжает разговор.
      if (sessionId) args.push("--resume", sessionId);
      const proc = spawn(input.command ?? "claude", args, { cwd: input.cwd, env: cliEnv(), stdio: ["pipe", "pipe", "pipe"] });
      child = proc;
      const translator = new StreamJsonTranslator(emit);
      let out = "";
      let errTail = "";
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        out += chunk;
        let nl: number;
        while ((nl = out.indexOf("\n")) >= 0) {
          translator.line(out.slice(0, nl));
          out = out.slice(nl + 1);
          if (translator.sessionId) sessionId = translator.sessionId;
          // Ход закончен — закрываем ввод, CLI выйдет сам.
          if (translator.result && !proc.stdin.destroyed) proc.stdin.end();
        }
      });
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => { errTail = (errTail + chunk).slice(-2000); });
      proc.stdin.on("error", () => {});
      proc.stdin.write(userLine(text));
      const code: number | null = await new Promise((resolve) => {
        proc.once("error", (error) => { errTail = (errTail + error.message).slice(-2000); resolve(-1); });
        proc.once("close", (c) => resolve(c));
      });
      if (out.trim()) translator.line(out);
      child = null;
      const result = translator.result;
      const failed = aborted || !result || result.isError || (code !== 0 && code !== null);
      const errorMessage = aborted ? "ход прерван" : result?.isError ? result.text : !result ? (errTail.trim() || `claude завершился с кодом ${code}`) : undefined;
      // Тот же формат, что у Pi: lastAssistantLimitError смотрит stopReason/errorMessage.
      messages.push({
        role: "assistant",
        content: result && !result.isError ? [{ type: "text", text: result.text }] : [],
        stopReason: aborted ? "aborted" : failed ? "error" : "stop",
        ...(errorMessage ? { errorMessage } : {}),
      });
      if (!aborted && !result) throw new Error(`внешний агент не ответил: ${errorMessage}`.slice(0, 500));
    },
    steer(text) {
      if (child && !child.stdin.destroyed) child.stdin.write(userLine(text));
    },
    async abort() {
      aborted = true;
      child?.kill("SIGTERM");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      child?.kill("SIGTERM");
      listeners.clear();
      void bridge.close().catch(() => {});
    },
  };
  return session;
}
