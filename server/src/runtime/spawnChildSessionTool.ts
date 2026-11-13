import { defineTool, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const CHILD_SESSION_TOOLS = ["read", "grep", "find", "ls"] as const;

export interface ChildSessionAgent {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  dispose(): void;
}

export interface ChildSessionSpawnRequest {
  parentSessionId: string;
  parentSessionFile: string;
  task: string;
  cwd?: string;
  expectedOutput?: string;
  tools: readonly string[];
  /** Роль-субагент: дочерняя сессия с профилем роли. */
  role?: string;
}

export interface SpawnedChildSession {
  id: string;
  parentSession: string;
  session: ChildSessionAgent;
}

export interface SpawnChildSessionToolDependencies {
  parentSessionId: string;
  parentSessionFile: string;
  /** Роли, которых можно звать субагентом (ключ → название). */
  roles?: Record<string, string>;
  spawn(request: ChildSessionSpawnRequest): Promise<SpawnedChildSession>;
}

type ChildResultDetails = {
  status: "completed" | "failed" | "aborted";
  role?: string;
  sessionId: string;
  parentSession: string;
  output?: string;
  error?: string;
  eventType?: string;
};

function assistantText(message: any): string {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
}

function progressText(event: any): string {
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    return event.assistantMessageEvent.delta ?? "";
  }
  if (event.type === "message_end") return assistantText(event.message);
  if (event.type === "agent_settled") return event.aborted ? "Child session aborted" : "Child session settled";
  return `Child session: ${String(event.type)}`;
}

/** A normal persistent Pi child session exposed as one parent tool call. */
export function createSpawnChildSessionTool(dependencies: SpawnChildSessionToolDependencies) {
  return defineTool({
    name: "taskflow_spawn_session",
    label: "Spawn session",
    description:
      "Поручить задачу субагенту и получить его ответ. Субагент — роль команды (role): " +
      "она работает в своей дочерней сессии со своими инструкцией, навыками и инструментами " +
      "и возвращает результат сюда. Без role — короткая задача только на чтение." +
      (dependencies.roles && Object.keys(dependencies.roles).length
        ? " Роли: " + Object.entries(dependencies.roles).map(([key, title]) => `${key} — ${title}`).join("; ") + "."
        : ""),
    promptSnippet: "taskflow_spawn_session: поручить задачу роли-субагенту (role) и получить её ответ",
    parameters: Type.Object({
      role: Type.Optional(Type.String({ minLength: 1, description: "Ключ роли-субагента (например researcher, designer, builder)" })),
      task: Type.String({ minLength: 1, description: "Concrete task for the child session" }),
      cwd: Type.Optional(Type.String({ minLength: 1, description: "Working directory; defaults to the parent cwd" })),
      expectedOutput: Type.Optional(Type.String({ minLength: 1, description: "Expected result shape" })),
    }),
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const role = params.role?.trim() || undefined;
      if (role && dependencies.roles && !(role in dependencies.roles)) {
        throw new Error(`НЕИЗВЕСТНАЯ РОЛЬ «${role}». Доступные роли: ${Object.keys(dependencies.roles).join(", ")}.`);
      }
      const child = await dependencies.spawn({
        role,
        parentSessionId: dependencies.parentSessionId,
        parentSessionFile: dependencies.parentSessionFile,
        task: params.task,
        cwd: params.cwd,
        expectedOutput: params.expectedOutput,
        tools: CHILD_SESSION_TOOLS,
      });

      let lastOutput = "";
      let settledReported = false;
      const unsubscribe = child.session.subscribe(event => {
        if (event.type === "message_end") {
          const text = assistantText((event as any).message);
          if (text) lastOutput = text;
        }
        if (event.type === "agent_settled") {
          if (settledReported) return;
          settledReported = true;
        }
        onUpdate?.({
          content: [{ type: "text", text: progressText(event) }],
          details: {
            status: event.type === "agent_settled" && (event as any).aborted ? "aborted" : "completed",
            sessionId: child.id,
            role,
            parentSession: child.parentSession,
            eventType: event.type,
          } satisfies ChildResultDetails,
        });
      });

      let abortRequested = signal?.aborted ?? false;
      const onAbort = () => {
        abortRequested = true;
        void child.session.abort();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        if (abortRequested) {
          await child.session.abort();
          await child.session.waitForIdle();
          return {
            content: [{ type: "text", text: "Child session aborted" }],
            details: {
              status: "aborted",
              sessionId: child.id,
            role,
              parentSession: child.parentSession,
            } satisfies ChildResultDetails,
          };
        }

        const prompt = params.expectedOutput
          ? `${params.task}\n\nExpected output: ${params.expectedOutput}`
          : params.task;
        try {
          await child.session.prompt(prompt);
          await child.session.waitForIdle();
        } catch (error) {
          await child.session.waitForIdle();
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: `Child session failed: ${message}` }],
            details: {
              status: "failed",
              sessionId: child.id,
            role,
              parentSession: child.parentSession,
              error: message,
            } satisfies ChildResultDetails,
          };
        }

        if (abortRequested) {
          return {
            content: [{ type: "text", text: "Child session aborted" }],
            details: {
              status: "aborted",
              sessionId: child.id,
            role,
              parentSession: child.parentSession,
            } satisfies ChildResultDetails,
          };
        }
        return {
          content: [{ type: "text", text: lastOutput || "Child session completed" }],
          details: {
            status: "completed",
            sessionId: child.id,
            role,
            parentSession: child.parentSession,
            output: lastOutput,
          } satisfies ChildResultDetails,
        };
      } finally {
        signal?.removeEventListener("abort", onAbort);
        unsubscribe();
      }
    },
  });
}
