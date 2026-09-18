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
  /** Провайдер, на котором запускается Pi. Если не задан — Pi выберет по
   *  модели. 18.09.2026: провайдер обязателен, чтобы Pi не угадывал. */
  provider?: string;
  model?: string;
  prompt: string;
  tools?: string[];
}

export interface StartRunResult {
  runId: string;
  sessionId: string;
  status: AgentRun["status"];
}

/** Тело запроса на connectProvider. apiKey — для api_key провайдеров;
 *  для OAuth ничего не передаём, провайдер начинает flow сам. */
export interface ConnectProviderInput {
  apiKey?: string;
}

/** OAuth-flow события, которые адаптер пробрасывает в UI через AuthInteractive.
 *  AuthInteraction в Pi SDK делится на две ветки: device-code flow и
 *  browser-callback flow. Поле kind определяет, какие поля обязательны.
 *  ManualCode — для случая, когда у пользователя нет браузера на той же
 *  машине, и он вставляет код / URL вручную. */
export type AuthInteractiveEvent =
  | {
      kind: "auth_url";
      provider: string;
      url: string;
      instructions?: string;
    }
  | {
      kind: "device_code";
      provider: string;
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | {
      kind: "manual_code";
      provider: string;
      message: string;
      placeholder?: string;
    }
  | {
      kind: "progress";
      provider: string;
      message: string;
    }
  | {
      kind: "info";
      provider: string;
      message: string;
    };

/** Результат connectProvider/authInstruction для OAuth провайдера:
 *  нужен интерактивный flow. UI подписывается на events и показывает их
 *  пользователю (открыть URL, показать device_code, принять manual_code).
 *  Promised completed резолвится, когда SDK login() завершается (credentials
 *  записаны) или реджектится при отмене. */
export interface AuthInteractive {
  status: "auth_required";
  provider: string;
  events: AsyncIterable<AuthInteractiveEvent>;
  completed: Promise<void>;
  cancel(): void;
}

/** Старая AuthInstruction оставлена для совместимости с прежним контрактом
 *  роута /api/runtime/providers/:id/auth (раньше возвращалась команда для
 *  интерактивного TUI; теперь — AuthInteractive). В новом коде
 *  используйте AuthInteractive. */
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
  ): Promise<ProviderConnection | AuthInteractive>;
  authInstruction(provider: string): Promise<AuthInstruction | AuthInteractive>;
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
