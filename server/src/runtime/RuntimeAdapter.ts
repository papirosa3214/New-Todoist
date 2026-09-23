import type {
  AgentProfile,
  AgentRun,
  Model,
  ProviderConnection,
  Runtime,
  RuntimeId,
} from "./types.js";
import type { AuthSessionView } from "./AuthSession.js";

export interface StartRunInput {
  taskId: string;
  agentId: string;
  /** Провайдер, на котором запускается Pi. Если не задан — выводится из
   *  модели или из routing роли. */
  provider?: string;
  model?: string;
  prompt: string;
  tools?: string[];
  /** Рабочая папка запуска (репозиторий проекта). По умолчанию — папка сервера. */
  cwd?: string;
}

export interface StartRunResult {
  runId: string;
  /** Реальный sessionId из Pi (client.getState().sessionId) либо null,
   *  если Pi его ещё не отдал. Никаких пустых строк и выдуманных id. */
  sessionId: string | null;
  status: AgentRun["status"];
}

/** Тело запроса на connectProvider. apiKey — для api_key провайдеров;
 *  для OAuth вместо этого стартует AuthSession (см. RuntimeAdapter). */
export interface ConnectProviderInput {
  apiKey?: string;
}

/** Абстракция над runtime: TaskFlow говорит с рантаймом через этот
 *  интерфейс. Единственная реализация — PiRuntimeAdapter, потому что
 *  единственный runtime — Pi. */
export interface RuntimeAdapter {
  readonly id: RuntimeId;
  status(): Promise<Runtime>;
  listProfiles(): Promise<AgentProfile[]>;
  listModels(): Promise<Model[]>;
  listProviders(): Promise<ProviderConnection[]>;
  /** api_key: пишет credential в штатный persistent store Pi
   *  (ModelRuntime.login) и возвращает обновлённый статус. OAuth этим
   *  методом не запускается — для него startAuthSession(). */
  connectProvider(
    provider: string,
    body: ConnectProviderInput,
  ): Promise<ProviderConnection>;
  /** Стартует интерактивный OAuth-login в фоне. Возвращает AuthSession
   *  сразу, не дожидаясь прохождения OAuth у пользователя (спека §3-5). */
  startAuthSession(provider: string): Promise<AuthSessionView>;
  getAuthSession(id: string): AuthSessionView | null;
  submitAuthInput(id: string, value: string): void;
  cancelAuthSession(id: string): void;
  startRun(input: StartRunInput): Promise<StartRunResult>;
  sendMessage(runId: string, text: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  getRun(runId: string): Promise<AgentRun>;
}

export class UnsupportedInFacadeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedInFacadeError";
  }
}
