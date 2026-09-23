// Типизированные ошибки runtime-слоя. Нужны, чтобы HTTP-роут мог честно
// различить «Pi недоступен» (503 runtime_unavailable) и «модели нет в
// каталоге Pi» (422 model_not_available). До этого listModels() глотал
// любую ошибку и отдавал [], из-за чего UI/realtime отвечали 422
// model_not_available даже когда виноват лежащий Pi (спека §14).

export class RuntimeUnavailableError extends Error {
  readonly code = "runtime_unavailable";

  constructor(message = "Pi runtime is unavailable") {
    super(message);
    this.name = "RuntimeUnavailableError";
  }
}

export class ModelNotAvailableError extends Error {
  readonly code = "model_not_available";
  readonly model: string;
  readonly provider: string | null;

  constructor(model: string, provider?: string | null) {
    super(
      `model_not_available: ${provider ? `${provider}/` : ""}${model}`,
    );
    this.name = "ModelNotAvailableError";
    this.model = model;
    this.provider = provider ?? null;
  }
}

export class AuthSessionNotFoundError extends Error {
  readonly code = "auth_session_not_found";

  constructor(id: string) {
    super(`auth session ${id} not found`);
    this.name = "AuthSessionNotFoundError";
  }
}

export class AuthInputNotExpectedError extends Error {
  readonly code = "auth_input_not_expected";

  constructor(id: string) {
    super(`auth session ${id} is not waiting for user input`);
    this.name = "AuthInputNotExpectedError";
  }
}
