import type {
  AgentProfile,
  AgentRun,
  Model,
  ProviderConnection,
  Runtime,
  RuntimeId,
} from "./types.js";

export interface StartRunInput {
  taskId: string;
  agentId: string;
  model?: string;
  prompt: string;
  tools?: string[];
}

export interface StartRunResult {
  runId: string;
  sessionId: string;
  status: AgentRun["status"];
}

/** Тело запроса на connectProvider. Сейчас принимает только apiKey для
 *  api_key провайдеров. OAuth в UI не принимается (см. спек §D). */
export interface ConnectProviderInput {
  apiKey?: string;
}

/** Инструкция для случаев, когда Pi сам управляет авторизацией
 *  (OAuth): готовую команду пользователь запускает у себя в TUI. */
export interface AuthInstruction {
  status: "auth_required";
  provider: string;
  command: string;
  note: string;
}

/** Абстракция над runtime: TaskFlow говорит с рантаймом через этот
 *  интерфейс. На первом этапе единственная реализация — PiRuntimeAdapter,
 *  потому что единственный runtime — Pi. ClaudeCodeRuntime и CodexRuntime
 *  отложены (см. спек). */
export interface RuntimeAdapter {
  readonly id: RuntimeId;
  status(): Promise<Runtime>;
  listProfiles(): Promise<AgentProfile[]>;
  listModels(): Promise<Model[]>;
  listProviders(): Promise<ProviderConnection[]>;
  connectProvider(
    provider: string,
    body: ConnectProviderInput,
  ): Promise<ProviderConnection>;
  authInstruction(provider: string): Promise<AuthInstruction>;
  startRun(input: StartRunInput): Promise<StartRunResult>;
  sendMessage(runId: string, text: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  getRun(runId: string): Promise<AgentRun>;
}

/** В этой версии фасада процесс всё ещё запускает server/scripts/trigger.py,
 *  а RuntimeAdapter.startRun()/sendMessage()/cancelRun() — заглушки. Реальная
 *  интеграция — отдельная карточка (см. план, Task 9). */
export class UnsupportedInFacadeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedInFacadeError";
  }
}
