// Сессия внешнего агента Claude Code с той же поверхностью, что у сессии Pi
// (subscribe / prompt / steer / abort / dispose / state.messages), — чтобы
// runRoleInProcess, live-ход, сторож тишины и снимки слота работали без
// изменений.
//
// Внешний агент — самостоятельный участник (roles.runtime, заводится кнопкой
// «Обновить» из каталога externalAgents.ts), а не подмена модели во внутренней
// роли (владелец 19.10.2026). Он работает в своём окружении целиком: своя
// модель, память, CLAUDE.md, скиллы, свои MCP — TaskFlow ничего не отключает
// и не подменяет. От TaskFlow он получает только инструкцию-буст и задание;
// действия на доске отдаёт блоком `taskflow-actions` (externalAgentActions.ts),
// сервер выполняет их сам и возвращает итог следующим сообщением.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";

/** Встроенные инструменты Claude Code → имена Pi (их понимают live-ход и журнал активности). */
const BUILTIN_NAMES: Record<string, string> = {
  Bash: "bash",
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "write",
  Grep: "grep",
  Glob: "find",
  LS: "ls",
};
export function piToolName(name: string): string {
  return BUILTIN_NAMES[name] ?? name;
}

type Listener = (event: any) => void;

/** Окружение CLI без чужих ключей: ANTHROPIC_* у сервера — для Pi, и CLI с ними
 *  ушёл бы на оплату по ключу вместо своего входа (или в «Not logged in»). */
export function cliEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out = Object.fromEntries(
    Object.entries(env).filter(
      ([k]) => !/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$)/.test(k),
    ),
  );
  // У systemd-сервиса PATH короткий: без этих папок агент не видит своих инструментов (gh, graft, hermes…).
  const home = os.homedir();
  const extra = [
    path.join(home, ".local/bin"),
    path.join(home, ".npm-global/bin"),
    "/usr/local/bin",
  ];
  const have = (out.PATH ?? "").split(":").filter(Boolean);
  out.PATH = [...have, ...extra.filter((d) => !have.includes(d))].join(":");
  return out;
}

export interface CliSessionInput {
  cwd: string;
  /** Модель для `--model`; не задана — своя модель агента по умолчанию. */
  model?: string;
  /** Инструкция-буст TaskFlow: добавляется к собственному системному промпту агента. */
  systemPrompt: string;
  /** После хода: разобрать ответ и вернуть сообщение с итогами действий или null — ход окончен. */
  onTurnEnd?: (text: string) => Promise<string | null>;
  /** Сколько раз подряд можно вернуть агенту итоги действий за один prompt. */
  maxFollowUps?: number;
  /** Бинарник агента (из каталога); по умолчанию claude. */
  command?: string;
  /** Добавки к окружению агента (например, TASKFLOW_TOKEN участника). */
  env?: Record<string, string>;
  /** Агент сообщил, на какой модели работает (из начала хода). */
  onModel?: (model: string) => void;
  /** Продолжить прежнюю сессию агента (чат между сообщениями). */
  resumeSessionId?: string | null;
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
  model: string | null = null;
  result: { isError: boolean; text: string } | null = null;
  private partialText = false;
  private partialThinking = false;
  /** Размер запроса последнего обращения к модели и число обращений. */
  private lastContext = 0;
  private callIds = new Set<string>();

  constructor(private readonly emit: (event: any) => void) {}

  line(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (
      msg.type === "system" &&
      msg.subtype === "init" &&
      typeof msg.session_id === "string"
    ) {
      this.sessionId = msg.session_id;
      if (typeof msg.model === "string") this.model = msg.model;
      return;
    }
    if (msg.type === "stream_event") {
      const ev = msg.event;
      if (
        ev?.type === "content_block_start" &&
        ev.content_block?.type === "thinking"
      ) {
        this.partialThinking = true;
        this.emit({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_start" },
        });
      } else if (
        ev?.type === "content_block_delta" &&
        ev.delta?.type === "text_delta"
      ) {
        this.partialText = true;
        this.emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: ev.delta.text ?? "",
          },
        });
      } else if (
        ev?.type === "content_block_delta" &&
        ev.delta?.type === "thinking_delta"
      ) {
        this.emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_delta",
            delta: ev.delta.thinking ?? "",
          },
        });
      } else if (ev?.type === "content_block_stop" && this.partialThinking) {
        this.partialThinking = false;
        this.emit({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_end" },
        });
      }
      return;
    }
    if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
      const mu = msg.message.usage;
      if (mu && typeof mu === "object") {
        this.callIds.add(String(msg.message.id ?? this.callIds.size));
        this.lastContext = (mu.input_tokens ?? 0) + (mu.cache_read_input_tokens ?? 0) + (mu.cache_creation_input_tokens ?? 0);
      }
      const content: any[] = [];
      for (const block of msg.message.content) {
        if (block?.type === "text") {
          content.push({ type: "text", text: block.text ?? "" });
          // Без частичных сообщений текст приходит только целиком.
          if (!this.partialText)
            this.emit({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                delta: block.text ?? "",
              },
            });
        } else if (block?.type === "thinking") {
          content.push({ type: "thinking", thinking: block.thinking ?? "" });
        } else if (block?.type === "tool_use") {
          this.emit({
            type: "tool_execution_start",
            toolCallId: block.id,
            toolName: piToolName(String(block.name)),
            args: block.input ?? {},
          });
        }
      }
      this.partialText = false;
      if (content.length)
        this.emit({
          type: "message_end",
          message: { role: "assistant", content },
        });
      return;
    }
    if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block?.type === "tool_result") {
          this.emit({
            type: "tool_execution_end",
            toolCallId: block.tool_use_id,
            isError: block.is_error === true,
          });
        }
      }
      return;
    }
    if (msg.type === "result") {
      const isError =
        msg.is_error === true ||
        (typeof msg.subtype === "string" && msg.subtype.startsWith("error"));
      const text =
        typeof msg.result === "string"
          ? msg.result
          : Array.isArray(msg.errors)
            ? msg.errors.join("; ")
            : String(msg.subtype ?? "");
      this.result = { isError, text };
      // Расход хода — строка под ответом в чате: токены, кэш, цена.
      const u = msg.usage;
      if (u && typeof u === "object") {
        const n = (v: unknown) =>
          typeof v === "number" && Number.isFinite(v) ? v : 0;
        this.emit({
          type: "turn_usage",
          usage: {
            input: n(u.input_tokens),
            output: n(u.output_tokens),
            cacheRead: n(u.cache_read_input_tokens),
            cacheWrite: n(u.cache_creation_input_tokens),
            costUsd:
              typeof msg.total_cost_usd === "number"
                ? msg.total_cost_usd
                : null,
            generationMs:
              typeof msg.duration_api_ms === "number"
                ? msg.duration_api_ms
                : null,
            model: this.model,
            contextTokens: this.lastContext,
            calls: this.callIds.size || 1,
          },
        });
      }
    }
  }
}

export async function createCliAgentSession(
  input: CliSessionInput,
): Promise<CliAgentSession> {
  const listeners = new Set<Listener>();
  const messages: any[] = [];
  let sessionId: string | null = input.resumeSessionId ?? null;
  let reportedModel: string | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  let aborted = false;
  let disposed = false;
  const emit = (event: any) => {
    for (const l of listeners) {
      try {
        l(event);
      } catch {
        /* слушатель не роняет ход */
      }
    }
  };
  const userLine = (text: string) =>
    JSON.stringify({ type: "user", message: { role: "user", content: text } }) +
    "\n";

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
      for (
        let turn = 0;
        next !== null && turn <= (input.maxFollowUps ?? 3);
        turn++
      ) {
        await runTurn(next);
        const last = messages[messages.length - 1];
        if (aborted || last?.stopReason !== "stop" || !input.onTurnEnd) return;
        const answer = (last.content ?? [])
          .map((c: any) => c?.text ?? "")
          .join("\n");
        next = await input.onTurnEnd(answer);
      }
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
    },
  };

  async function runTurn(text: string): Promise<void> {
    if (disposed) throw new Error("сессия внешнего агента закрыта");
    if (child) throw new Error("внешний агент уже выполняет ход");
    aborted = false;
    messages.push({ role: "user", content: [{ type: "text", text }] });
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--append-system-prompt",
      input.systemPrompt,
      // Без подтверждений, как роль на Pi: в фоне спросить некого.
      "--permission-mode",
      "bypassPermissions",
    ];
    if (input.model) args.push("--model", input.model);
    // Следующий prompt той же сессии (например, резюме при остановке) продолжает разговор.
    if (sessionId) args.push("--resume", sessionId);
    const proc = spawn(input.command ?? "claude", args, {
      cwd: input.cwd,
      env: { ...cliEnv(), ...input.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
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
        if (translator.model && translator.model !== reportedModel) {
          reportedModel = translator.model;
          try {
            input.onModel?.(reportedModel);
          } catch {
            /* не роняет ход */
          }
        }
        // Ход закончен — закрываем ввод, CLI выйдет сам.
        if (translator.result && !proc.stdin.destroyed) proc.stdin.end();
      }
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      errTail = (errTail + chunk).slice(-2000);
    });
    proc.stdin.on("error", () => {});
    proc.stdin.write(userLine(text));
    const code: number | null = await new Promise((resolve) => {
      proc.once("error", (error) => {
        errTail = (errTail + error.message).slice(-2000);
        resolve(-1);
      });
      proc.once("close", (c) => resolve(c));
    });
    if (out.trim()) translator.line(out);
    child = null;
    const result = translator.result;
    const failed =
      aborted || !result || result.isError || (code !== 0 && code !== null);
    const errorMessage = aborted
      ? "ход прерван"
      : result?.isError
        ? result.text
        : !result
          ? errTail.trim() || `claude завершился с кодом ${code}`
          : undefined;
    // Тот же формат, что у Pi: lastAssistantLimitError смотрит stopReason/errorMessage.
    messages.push({
      role: "assistant",
      content:
        result && !result.isError ? [{ type: "text", text: result.text }] : [],
      stopReason: aborted ? "aborted" : failed ? "error" : "stop",
      ...(errorMessage ? { errorMessage } : {}),
    });
    if (!aborted && !result)
      throw new Error(
        `внешний агент не ответил: ${errorMessage}`.slice(0, 500),
      );
  }
  return session;
}
