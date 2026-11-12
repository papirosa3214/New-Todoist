// Протокол «хост ↔ шлюз», ВЗЯТ ИЗ ТИКЕТА 1.
//
// Источник истины — `server/src/host/protocol.ts` в репозитории TaskFlow
// (коммит ad7de588). Это не «похожий» контракт и не пересказ плана: хост и
// шлюз обязаны говорить ОДНИМ словарём, иначе они не стыкуются. Копия нужна
// потому, что серверный модуль лежит в репозитории сервера на .110, а хост
// собирается на маке из своего каталога и тащить репозиторий сервера не
// должен. Копию можно заменить импортом, как только появится общий пакет.
//
// ЧТО ИЗМЕНИЛОСЬ ПО СРАВНЕНИЮ С ПРЕЖНЕЙ ВЕРСИЕЙ ХОСТА (14.10.2026) и почему
// гость с шлюзом не сошётся:
//
//   1. Ключ машины уходит НЕ в приветствии, а в строке подключения `?key=`.
//      Сервер проверяет его ДО того, как вообще примет хоста, и по нему же
//      определяет машину. Прежняя версия клала ключ в `hello` — этого поля
//      сервер не читает, ключ просто терялся.
//   2. Шага `register` → `registered` НЕТ. Корни приезжают вторым `welcome`
//      сразу после `hello`. Прежняя версия ждала `registered` вечно и падала
//      по таймауту рукопожатия.
//   3. `call` переименован в `op`, `chunk` в `op_chunk` (поле `text` →
//      `data`), `result` в `op_result`, `cancel` в `op_cancel`.
//   4. `op_result` при ok:true несёт `exitCode`/`stdout`/`stderr`/`truncated`,
//      а не только `data`. При ok:false — строки `error` и `code`, а не объект
//      `{code, message}`.
//   5. Отказ шлюза — `error: "unauthorized"`, а не `reject` с кодом.
//   6. `ping`/`pong` без поля `at`: пинг шлёт СЕРВЕР, хост только отвечает.

export const PROTOCOL_VERSION = 1;

/** Как часто сервер ждёт ответа на ping (сервер шлёт, хост отвечает). */
export const HOST_PING_MS = 20_000;

/** Потолок вывода одной операции. Сервер держит его у себя, хост — про запас. */
export const HOST_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Потолок времени одной операции. Сборка Xcode идёт минутами, но не вечность. */
export const HOST_DEFAULT_TIMEOUT_MS = 600_000;

/** Операции, которые сервер умеет просить у хоста. Список закрытый. */
export const OP_NAMES = [
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "git_worktree",
  "git_push",
  // Снятие ветки роли с хостов после слияния в main (решение владельца
  // 10.11.2026). Без удаления ветви копились сотнями на GitHub и в Gitea.
  "git_delete_branch",
] as const;
export type OpName = (typeof OP_NAMES)[number];

export type StreamName = "stdout" | "stderr";

/**
 * Коды ошибок операции. В протоколе это свободная строка — сервер не
 * проверяет её и отдаёт роль как есть. Список нужен хосту, чтобы свои же
 * ошибки не путать с «хост сломался».
 */
export type ProtocolErrorCode =
  | "path_denied"
  | "bad_args"
  | "not_found"
  | "cancelled"
  | "timeout"
  | "limit_exceeded"
  | "internal";

export function isOpName(value: unknown): value is OpName {
  return typeof value === "string" && (OP_NAMES as readonly string[]).includes(value);
}

// ───────────────────────── сообщения хоста → шлюзу ─────────────────────────

/**
 * Приветствие. Ключа здесь нет и быть не должно: сервер сверил его уже на
 * подключении, а машину определил по нему. Хост не может назвать себя чужой.
 */
export interface HelloMessage {
  type: "hello";
  protocolVersion?: number;
  /** Версия самого хоста (сборка программы), чтобы отличать старый хост. */
  hostVersion?: string;
  platform?: string;
  /** Корни, которые хост считает своими. Разрешённым станет ПЕРЕСЕЧЕНИЕ. */
  roots?: string[];
}

export interface PongMessage {
  type: "pong" };

/** Кусок потока команды. */
export interface OpChunkMessage {
  type: "op_chunk";
  opId: string;
  stream: StreamName;
  data: string;
}

/**
 * Результат операции.
 *
 * `ok:false` — НЕ «хост сломался»: это честный ответ «пути нет» или
 * «значение не подходит». Роль читает текст ошибки как данные, поэтому
 * ошибка операции уезжает именно сюда, а не вылетает исключением.
 *
 * `exitCode` — код завершения команды (для bash). Непустой код это данные,
 * а не ошибка: сервер отдаёт его роли как есть.
 */
export type OpResultMessage =
  | {
      type: "op_result";
      opId: string;
      ok: true;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      truncated?: boolean;
      /** Полезная нагрузка операции: счётчики для bash, текст для read. */
      data?: unknown;
    }
  | {
      type: "op_result";
      opId: string;
      ok: false;
      error: string;
      code?: string;
    };

export type HostMessage = HelloMessage | PongMessage | OpChunkMessage | OpResultMessage;

// ───────────────────────── сообщения шлюза → хосту ─────────────────────────

/**
 * «Ты принят, вот твоя машина и правила».
 *
 * Приходит ДВАЖДЫ, и это не опечатка:
 *   1. сразу после проверки ключа — с серверными корнями, чтобы хост, который
 *      ждёт ответа на подключение, не висел на своём таймауте;
 *   2. после `hello` — с ПЕРЕСЕЧЕНИЕМ серверных и хостовых корней.
 *
 * Второй welcome и есть окончательный: работать можно только в корнях из
 * него, а не из первого. Первый — с серверными корнями ещё до того, как хост
 * назвал свои.
 */
export interface WelcomeMessage {
  type: "welcome";
  protocolVersion: number;
  machineId: string;
  machineName: string;
  /** Разрешённые корни: пересечение серверных с корнями из hello. */
  allowedRoots: string[];
  /** Как часто ждать ping от сервера. */
  pingMs: number;
  maxOutputBytes: number;
  defaultTimeoutMs: number;
}

export interface PingMessage {
  type: "ping";
}

/** Вызов операции. `args` сервер не проверяет — это работа операции на хосте. */
export interface OpMessage {
  type: "op";
  opId: string;
  op: OpName | string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface OpCancelMessage {
  type: "op_cancel";
  opId: string;
}

/**
 * Отказ. Сейчас один: ключ не подошёл или машина отозвана. Наружу разные
 * причины не отдаются — иначе перебором можно выяснить, какие ключи выдавали.
 */
export interface ErrorMessage {
  type: "error";
  error: string;
}

export type GatewayMessage =
  | WelcomeMessage
  | PingMessage
  | OpMessage
  | OpCancelMessage
  | ErrorMessage;

// ───────────────────────── разбор сообщений ─────────────────────────

export type ParseResult = { ok: true; message: GatewayMessage } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
}

/**
 * Разбор кадра от шлюза. Отдаёт ошибку на всём, что не разобрано: шлюз —
 * чужая программа, и падать из-за её мусора хост не должен.
 */
export function parseGatewayMessage(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "кадр не разобран как JSON" };
  }
  if (!isRecord(parsed) || typeof parsed["type"] !== "string") {
    return { ok: false, error: "в кадре нет строкового поля type" };
  }

  switch (parsed["type"]) {
    case "welcome":
      return {
        ok: true,
        message: {
          type: "welcome",
          protocolVersion: typeof parsed["protocolVersion"] === "number" ? parsed["protocolVersion"] : 0,
          machineId: typeof parsed["machineId"] === "string" ? parsed["machineId"] : "",
          machineName: typeof parsed["machineName"] === "string" ? parsed["machineName"] : "",
          allowedRoots: readStringArray(parsed["allowedRoots"]),
          pingMs: typeof parsed["pingMs"] === "number" ? parsed["pingMs"] : HOST_PING_MS,
          maxOutputBytes:
            typeof parsed["maxOutputBytes"] === "number" ? parsed["maxOutputBytes"] : HOST_MAX_OUTPUT_BYTES,
          defaultTimeoutMs:
            typeof parsed["defaultTimeoutMs"] === "number" ? parsed["defaultTimeoutMs"] : HOST_DEFAULT_TIMEOUT_MS,
        },
      };
    case "ping":
      return { ok: true, message: { type: "ping" } };
    case "op":
      if (typeof parsed["opId"] !== "string") return { ok: false, error: "в op нет строкового opId" };
      return {
        ok: true,
        message: {
          type: "op",
          opId: parsed["opId"],
          op: typeof parsed["op"] === "string" ? parsed["op"] : "",
          args: isRecord(parsed["args"]) ? parsed["args"] : {},
          timeoutMs: typeof parsed["timeoutMs"] === "number" ? parsed["timeoutMs"] : undefined,
        },
      };
    case "op_cancel":
      if (typeof parsed["opId"] !== "string") return { ok: false, error: "в op_cancel нет строкового opId" };
      return { ok: true, message: { type: "op_cancel", opId: parsed["opId"] } };
    case "error":
      return {
        ok: true,
        message: {
          type: "error",
          error: typeof parsed["error"] === "string" ? parsed["error"] : "шлюз не объяснил отказ",
        },
      };
    default:
      return { ok: false, error: `шлюз прислал неизвестный кадр «${String(parsed["type"])}»` };
  }
}

export function encode(message: HostMessage | GatewayMessage): string {
  return JSON.stringify(message);
}