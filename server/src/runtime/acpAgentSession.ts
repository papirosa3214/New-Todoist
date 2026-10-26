// Сессия внешнего агента по ACP (Agent Client Protocol) с той же поверхностью,
// что у сессии Claude Code (cliAgentSession.ts) и сессии Pi: subscribe /
// prompt / steer / abort / dispose / state.messages. Так чат, шаги плана,
// живой ход и сторож тишины работают с любым ACP-агентом без переделок.
//
// Протокол — официальный SDK @agentclientprotocol/sdk (v1, stdio, JSON-RPC).
// Один процесс агента и одна ACP-сессия на весь разговор: агент сам держит
// контекст, TaskFlow отдаёт ему только инструкцию (в первом ходе) и задания.
// Агенты, умеющие ACP сами: Gemini CLI (`gemini --acp`), OpenCode
// (`opencode acp`), Hermes (`hermes acp`) — проверено 26.10.2026.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type McpServer,
  type PermissionOption,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { cliEnv, type CliAgentSession, type CliSessionInput } from "./cliAgentSession.js";

type Listener = (event: any) => void;

export interface AcpSessionInput extends CliSessionInput {
  /** Аргументы запуска агента в режиме ACP (например, ["--acp"] или ["acp"]). */
  args: string[];
  /** MCP-серверы, которые агент подключит в сессии (например, TaskFlow). */
  mcpServers?: McpServer[];
}

/** Разрешение без человека, как `--permission-mode bypassPermissions` у Claude Code. */
export function pickAllowOption(options: PermissionOption[]): string | null {
  const allow =
    options.find((o) => o.kind === "allow_once") ??
    options.find((o) => o.kind === "allow_always");
  return allow?.optionId ?? null;
}

/** Переводчик событий ACP `session/update` в события Pi. Отдельно — чтобы проверять без процесса. */
export class AcpUpdateTranslator {
  text = "";
  private thinking = false;
  private openTools = new Set<string>();

  constructor(private readonly emit: (event: any) => void) {}

  private endThinking(): void {
    if (!this.thinking) return;
    this.thinking = false;
    this.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } });
  }

  update(u: SessionUpdate): void {
    switch (u.sessionUpdate) {
      case "agent_thought_chunk": {
        if (u.content.type !== "text") return;
        if (!this.thinking) {
          this.thinking = true;
          this.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } });
        }
        this.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: u.content.text } });
        return;
      }
      case "agent_message_chunk": {
        if (u.content.type !== "text") return;
        this.endThinking();
        this.text += u.content.text;
        this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: u.content.text } });
        return;
      }
      case "tool_call": {
        this.endThinking();
        this.openTools.add(u.toolCallId);
        this.emit({
          type: "tool_execution_start",
          toolCallId: u.toolCallId,
          toolName: u.kind ?? u.title,
          args: u.rawInput ?? {},
        });
        if (u.status === "completed" || u.status === "failed") this.finishTool(u.toolCallId, u.status === "failed");
        return;
      }
      case "tool_call_update": {
        if (u.status === "completed" || u.status === "failed") this.finishTool(u.toolCallId, u.status === "failed");
        return;
      }
      default:
        return;
    }
  }

  private finishTool(id: string, isError: boolean): void {
    if (!this.openTools.delete(id)) return;
    this.emit({ type: "tool_execution_end", toolCallId: id, isError });
  }

  /** Ход закончен: закрыть мысль и незакрытые инструменты. */
  finish(): void {
    this.endThinking();
    for (const id of [...this.openTools]) this.finishTool(id, true);
  }
}

export async function createAcpAgentSession(input: AcpSessionInput): Promise<CliAgentSession> {
  const listeners = new Set<Listener>();
  const messages: any[] = [];
  const steerQueue: string[] = [];
  let sessionId: string | null = null;
  let proc: ChildProcessWithoutNullStreams | null = null;
  let conn: ClientConnection | null = null;
  let translator: AcpUpdateTranslator | null = null;
  let running = false;
  let aborted = false;
  let disposed = false;
  let instructed = false;
  let errTail = "";

  const emit = (event: any) => {
    for (const l of listeners) {
      try {
        l(event);
      } catch {
        /* слушатель не роняет ход */
      }
    }
  };

  async function connect(): Promise<void> {
    if (conn && sessionId) return;
    const child = spawn(input.command ?? "", input.args, {
      cwd: input.cwd,
      env: { ...cliEnv(), ...input.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      errTail = (errTail + chunk).slice(-2000);
    });
    child.stdin.on("error", () => {});
    const spawnFailed = new Promise<never>((_, reject) => {
      child.once("error", (error) => reject(error));
      child.once("close", (code) => reject(new Error(`агент завершился с кодом ${code}: ${errTail.trim().slice(-500)}`)));
    });
    spawnFailed.catch(() => {});
    const app = client({ name: "taskflow" })
      .onNotification(methods.client.session.update, async ({ params }) => {
        if (params.sessionId === sessionId) translator?.update(params.update);
      })
      .onRequest(methods.client.session.requestPermission, async ({ params }) => {
        if (aborted) return { outcome: { outcome: "cancelled" } };
        const optionId = pickAllowOption(params.options);
        return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
      });
    conn = app.connect(ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
    await Promise.race([
      conn.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
      spawnFailed,
    ]);
    const created = await Promise.race([
      conn.agent.request(methods.agent.session.new, { cwd: input.cwd, mcpServers: input.mcpServers ?? [] }),
      spawnFailed,
    ]);
    sessionId = created.sessionId;
  }

  async function runTurn(text: string): Promise<void> {
    if (disposed) throw new Error("сессия внешнего агента закрыта");
    if (running) throw new Error("внешний агент уже выполняет ход");
    running = true;
    aborted = false;
    messages.push({ role: "user", content: [{ type: "text", text }] });
    emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
    const turn = new AcpUpdateTranslator(emit);
    translator = turn;
    let stopReason: string | null = null;
    let failure: string | undefined;
    try {
      await connect();
      // У ACP нет отдельного системного промпта: инструкция TaskFlow идёт
      // в начале первого сообщения разговора.
      const body = instructed ? text : `${input.systemPrompt}\n\n---\n\n${text}`;
      instructed = true;
      const response = await conn!.agent.request(methods.agent.session.prompt, {
        sessionId: sessionId!,
        prompt: [{ type: "text", text: body }],
      });
      stopReason = response.stopReason;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      turn.finish();
      translator = null;
      running = false;
    }
    const ok = !failure && stopReason === "end_turn";
    const wasAborted = aborted || stopReason === "cancelled";
    const errorMessage = wasAborted
      ? "ход прерван"
      : failure ?? (stopReason && stopReason !== "end_turn" ? `агент остановился: ${stopReason}` : undefined);
    if (turn.text) emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: turn.text }] } });
    // Расход хода (turn_usage) не шлём: ACP v1 отдаёт только заполнение
    // контекста, а токены входа/выхода и цену — нет; нули под ответом были бы выдумкой.
    // Тот же формат, что у Pi: lastAssistantLimitError смотрит stopReason/errorMessage.
    messages.push({
      role: "assistant",
      content: turn.text ? [{ type: "text", text: turn.text }] : [],
      stopReason: wasAborted ? "aborted" : ok ? "stop" : "error",
      ...(errorMessage ? { errorMessage } : {}),
    });
    if (failure && !wasAborted) throw new Error(`внешний агент не ответил: ${failure}`.slice(0, 500));
  }

  const session: CliAgentSession = {
    systemPrompt: input.systemPrompt,
    thinkingLevel: "off",
    state: { messages },
    get sessionId() {
      return sessionId;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async prompt(text) {
      let next: string | null = text;
      for (let turn = 0; next !== null && turn <= (input.maxFollowUps ?? 3); turn++) {
        await runTurn(next);
        // Уточнение, пришедшее во время хода, — следующим ходом той же сессии:
        // в ACP нет ввода посреди хода.
        if (steerQueue.length && !disposed) {
          next = steerQueue.splice(0).join("\n\n");
          continue;
        }
        const last = messages[messages.length - 1];
        if (aborted || last?.stopReason !== "stop" || !input.onTurnEnd) return;
        const answer = (last.content ?? []).map((c: any) => c?.text ?? "").join("\n");
        next = await input.onTurnEnd(answer);
      }
    },
    async steer(text) {
      if (disposed) throw new Error("внешний агент не принимает ввод");
      steerQueue.push(text);
    },
    async abort() {
      aborted = true;
      if (conn && sessionId && running) {
        await conn.agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => {});
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      conn?.close();
      proc?.kill("SIGTERM");
      listeners.clear();
    },
  };
  return session;
}
