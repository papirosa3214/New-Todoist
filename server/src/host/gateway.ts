/**
 * Шлюз хостов: живые сокеты машин, пинги и доставка операций (тикет 1).
 *
 * Здесь держим то, чего нет в базе: кто сейчас подключён. Онлайн-статус в
 * `machines.online` — тоже про это, но он нужен читателям (приложение, роль),
 * а не шлюзу: шлюзу важно, какой ИМЕННО сокет жив, чтобы послать в него op и
 * чтобы знать, кому закрывать сокет при отзыве.
 *
 * Чего шлюз НЕ делает: не выполняет операции. Он отдал вызов хосту и ждёт
 * ответа — всё исполнение на машине (план taskflow-host, D6: путь проверяет
 * хост, а не сервер; сервер не должен уметь исполнять код на чужой машине).
 *
 * Это модуль для роли/рантайма (тикет 3 пользуется `runOperation` и
 * `isMachineOnline` напрямую, минуя HTTP) — поэтому API здесь функциональный,
 * без fastify.
 */
import crypto from "node:crypto";
import {
  HOST_DEFAULT_TIMEOUT_MS,
  HOST_MAX_OUTPUT_BYTES,
  HOST_PING_MS,
  HOST_PROTOCOL_VERSION,
  isHostOperation,
  parseHostMessage,
  type HostOperation,
  type OpCancelMessage,
  type OpChunkMessage,
  type OpMessage,
  type ServerToHost,
} from "./protocol.js";
import {
  findMachineByName,
  getMachine,
  logMachineEvent,
  markMachineOffline,
  markMachineOnline,
  markMachineSeen,
  revokeMachine,
  type Machine,
} from "./machines.js";

type HostSocket = {
  readyState: number;
  send: (data: string) => void;
  close?: (code?: number, reason?: string) => void;
};

/** Код закрытия отозванной машины. Свой, а не обычный: хост по нему
 *  понимает, что ключ отозван, и не переподключается в бесконечном цикле —
 *  ровно как телефон по 4401 (ws.ts). */
export const HOST_REVOKED_CLOSE_CODE = 4402;

/** machineId → живые сокеты. Несколько сокетов на машину возможно (хост
 *  переподключился, а старый сокет ещё не досочитан сервером) — операцию
 *  отдаём любому из живых. */
const hostSockets = new Map<string, Set<HostSocket>>();

type PendingOp = {
  machineId: string;
  opId: string;
  resolve: (result: OperationResult) => void;
  reject: (err: Error) => void;
  onChunk?: (chunk: { stream: "stdout" | "stderr"; data: string }) => void;
  /** Текст кадров op_chunk. Хост в op_result присылает пустые stdout/stderr. */
  stdoutChunks: string[];
  stderrChunks: string[];
  /** Сколько байт вывода уже отдали вызывающему — потолок держим на стороне
   *  сервера, потому что хост может быть старой версии и потолок не знать. */
  bytes: number;
  truncated: boolean;
  timer: NodeJS.Timeout;
  /** Снять слушатель abort с сигнала вызывающего. Сигнал может быть долгоживущим
   *  (один на заход роли, сотни операций), и без снятия Node копит слушатели и
   *  ругается предупреждением о MaxListeners. */
  снятьAbort?: () => void;
  /** Уже отменён ли вызов — чтобы результат, пришедший после отмены, её не воскресил. */
  cancelled: boolean;
};

const pendingOps = new Map<string, PendingOp>();

export type OperationSuccess = {
  ok: true;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  /** Полезная нагрузка операции: {path, entries} / {content} и подобное. */
  data?: unknown;
};
export type OperationFailure = { ok: false; error: string; code?: string };
export type OperationResult = OperationSuccess | OperationFailure;

/** Отправка по живому сокету. Мёртвый сокет — не повод ронять вызов: у
 *  машины их может быть несколько, и мы просто пробуем следующий. */
export function sendToHost(machineId: string, message: ServerToHost): boolean {
  const сокеты = hostSockets.get(machineId);
  if (!сокеты || сокеты.size === 0) return false;
  const payload = JSON.stringify(message);
  let доставлено = false;
  for (const socket of [...сокеты]) {
    if (socket.readyState !== 1) continue;
    try {
      socket.send(payload);
      доставлено = true;
      // Operations may have side effects: overlapping connections must not
      // execute the same command twice. Control messages still broadcast.
      if (message.type === "op") return true;
    } catch {
      // Сокет умер между проверкой и отправкой — следующий по списку.
    }
  }
  return доставлено;
}

/**
 * Зарегистрировать подключение машины. Возвращает false, если машина не
 * принимается (отозвана или ключ не тот) — вызывающий обязан отказать и
 * закрыть сокет, иначе неавторизованный клиент будет висеть открытым.
 */
export function attachHostSocket(
  machine: Machine,
  socket: HostSocket,
): boolean {
  if (machine.revoked_at) return false;
  if (!hostSockets.has(machine.id)) hostSockets.set(machine.id, new Set());
  hostSockets.get(machine.id)!.add(socket);
  // Онлайн пишем в базу здесь, а не после первого ping: приложение должно
  // увидеть «мак на связи» сразу после подключения, а не через 20 секунд.
  markMachineOnline(machine.id);
  return true;
}

/** Сокет закрылся: машина офлайн, и все её висящие операции падают. */
export function detachHostSocket(machineId: string, socket: HostSocket): void {
  const сокеты = hostSockets.get(machineId);
  if (!сокеты) return;
  сокеты.delete(socket);
  if (сокеты.size > 0) return; // ещё один сокет жив — машина на связи
  hostSockets.delete(machineId);
  markMachineOffline(machineId);
  logMachineEvent(machineId, "disconnected");
  // Хост пропал посреди команды (план, шаг 5 потока): вызов не должен висеть
  // до своего таймаута — он падает сразу, шаг роли уходит в blocked.
  failPendingOps(machineId, new Error("связь с машиной потеряна"));
}

/** Машина на связи прямо сейчас. Роль спрашивает это ДО запуска (D8), а не
 *  после таймаута. */
export function isMachineOnline(machineIdOrName: string): boolean {
  const машина = resolveMachine(machineIdOrName);
  if (!машина) return false;
  const сокеты = hostSockets.get(машина.id);
  if (!сокеты) return false;
  for (const socket of сокеты) if (socket.readyState === 1) return true;
  return false;
}

/** Найти машину по id, а если не нашли — по имени: роль говорит «mac». */
export function resolveMachine(idOrName: string): Machine | null {
  return getMachine(idOrName) ?? findMachineByName(idOrName);
}

export type RunOperationOptions = {
  /** Отмена вызывающего (AbortSignal инструмента роли). */
  signal?: AbortSignal;
  /** Поток вывода по мере поступления. */
  onChunk?: (chunk: { stream: "stdout" | "stderr"; data: string }) => void;
  timeoutMs?: number;
};

/**
 * Вызвать операцию на машине и дождаться результата.
 *
 * Падает (reject), когда отвечать некому или не о чем: машина офлайн, связь
 * потеряна, вызов отменён, хост не уложился в таймаут. Неудача самого хоста —
 * не исключение, а { ok: false }: команда, завершившаяся с кодом 1, для роли
 * это данные, а не поломка шлюза.
 */
export function runOperation(
  machineIdOrName: string,
  op: HostOperation,
  args: Record<string, unknown>,
  options: RunOperationOptions = {},
): Promise<OperationResult> {
  const машина = resolveMachine(machineIdOrName);
  if (!машина) {
    return Promise.reject(new Error(`машина «${machineIdOrName}» неизвестна`));
  }
  if (!isHostOperation(op)) {
    return Promise.reject(new Error(`операция «${op}» хосту не положена`));
  }
  if (!isMachineOnline(машина.id)) {
    // Проверяем именно сокет, а не machines.online: база может говорить
    // «онлайн» после падения процесса сервера, и роль ушла бы в команду,
    // которая не вернётся.
    return Promise.reject(new Error(`машина «${машина.name}» сейчас офлайн`));
  }

  const opId = crypto.randomUUID();
  const timeoutMs = options.timeoutMs ?? HOST_DEFAULT_TIMEOUT_MS;

  return new Promise<OperationResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingOps.delete(opId);
      pending.снятьAbort?.();
      // Хост не ответил — это зависший вызов: отменяем у хоста, чтобы он не
      // продолжал ждать, а вызывающему отдаём ошибку.
      sendToHost(машина.id, { type: "op_cancel", opId });
      reject(new Error(`хост не ответил за ${Math.round(timeoutMs / 1000)}с`));
    }, timeoutMs);
    timer.unref?.();

    const pending: PendingOp = {
      machineId: машина.id,
      opId,
      resolve,
      reject,
      onChunk: options.onChunk,
      stdoutChunks: [],
      stderrChunks: [],
      bytes: 0,
      truncated: false,
      timer,
      cancelled: false,
    };
    pendingOps.set(opId, pending);

    // Отмена вызывающего должна дойти до хоста, иначе команда на маке
    // продолжает ждать, пока сервер уже забыл о ней.
    const onAbort = () => cancelOperation(машина.id, opId);
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
      pending.снятьAbort = () => options.signal!.removeEventListener("abort", onAbort);
    }

    const доставлено = sendToHost(машина.id, {
      type: "op",
      opId,
      op,
      args,
      timeoutMs,
    });
    if (!доставлено) {
      clearTimeout(timer);
      pending.снятьAbort?.();
      pendingOps.delete(opId);
      reject(new Error(`машина «${машина.name}» сейчас офлайн`));
    }
  });
}

/** Отменить вызов. true — отмена ушла хосту; false — вызова уже нет. */
export function cancelOperation(
  machineIdOrName: string,
  opId: string,
): boolean {
  const pending = pendingOps.get(opId);
  if (!pending) return false;
  const машина = resolveMachine(machineIdOrName);
  const machineId = машина?.id ?? pending.machineId;
  pending.cancelled = true;
  clearTimeout(pending.timer);
  pendingOps.delete(opId);
  pending.снятьAbort?.();
  sendToHost(machineId, { type: "op_cancel", opId });
  pending.reject(new Error("вызов отменён"));
  return true;
}

/** Все висящие вызовы машины — «связь потеряна». */
function failPendingOps(machineId: string, error: Error) {
  for (const [opId, pending] of [...pendingOps]) {
    if (pending.machineId !== machineId) continue;
    clearTimeout(pending.timer);
    pending.снятьAbort?.();
    pendingOps.delete(opId);
    pending.reject(error);
  }
}

/** Закрыть сокеты машины — вызывается при отзыве ключа. Молча оставить их
 *  открытыми нельзя: отозванная машина продолжила бы получать операции. */
export function disconnectMachine(
  machineId: string,
  code = HOST_REVOKED_CLOSE_CODE,
  reason = "machine_revoked",
) {
  const сокеты = hostSockets.get(machineId);
  if (!сокеты) return;
  for (const socket of [...сокеты]) {
    try {
      socket.close?.(code, reason);
    } catch {
      // Уже мёртв — делать нечего.
    }
  }
  hostSockets.delete(machineId);
  markMachineOffline(machineId);
  failPendingOps(machineId, new Error("связь с машиной потеряна"));
}

/**
 * Отзыв ключа машины целиком: снять в базе И закрыть живые сокеты.
 *
 * Единая ручка, потому что отзыв в одном месте, а не в двух, — иначе очень
 * легко отозвать ключ, забыв закрыть сокет: машина продолжила бы получать
 * операции, будучи «непринимаемой» только по документам. Ошибиться тут
 * невозможно, потому что вызывающий может только эта функция.
 */
export function revokeHostMachine(
  machineId: string,
  reason?: string | null,
): boolean {
  const снят = revokeMachine(machineId, reason);
  disconnectMachine(machineId);
  return снят;
}

/**
 * Обработать сообщение от хоста: приветствие, ответ на пинг, поток, результат.
 * Возвращает false для всего, что серверу не адресовано — молчание вместо
 * исключения, потому что хост пишет чужой код.
 */
export function handleHostMessage(
  machineId: string,
  raw: unknown,
): boolean {
  const сообщение = parseHostMessage(raw);
  if (!сообщение) return false;

  switch (сообщение.type) {
    case "hello": {
      // hello присылает корни и версию хоста. Серверные корни остаются
      // главными: пересечение считается на welcome, и хост получает в ответ
      // именно пересечение, а не свой список.
      markMachineOnline(machineId, сообщение.hostVersion ?? null);
      return true;
    }
    case "pong": {
      markMachineSeen(machineId);
      return true;
    }
    case "op_chunk": {
      deliverChunk(machineId, сообщение);
      return true;
    }
    case "op_result": {
      deliverResult(machineId, сообщение);
      return true;
    }
    default:
      return false;
  }
}

function deliverChunk(machineId: string, chunk: OpChunkMessage) {
  const pending = pendingOps.get(chunk.opId);
  if (!pending || pending.machineId !== machineId || pending.cancelled) return;
  // Потолок держим здесь, а не на хосте: хост может быть старой версии и
  // про потолок не знать, а молчащий сервер из-за чужого `cat` — хуже отказа.
  const осталось = HOST_MAX_OUTPUT_BYTES - pending.bytes;
  if (осталось <= 0) {
    pending.truncated = true;
    return;
  }
  let данные = chunk.data;
  if (Buffer.byteLength(данные, "utf8") > осталось) {
    // Slice bytes, then drop an incomplete final UTF-8 code point rather
    // than decoding it to a replacement character that exceeds the budget.
    const bytes = Buffer.from(данные, "utf8");
    let end = осталось;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
    данные = bytes.subarray(0, end).toString("utf8");
    pending.truncated = true;
  }
  if (!данные) return;
  pending.bytes += Buffer.byteLength(данные, "utf8");
  if (chunk.stream === "stderr") pending.stderrChunks.push(данные);
  else pending.stdoutChunks.push(данные);
  pending.onChunk?.({ stream: chunk.stream, data: данные });
}

function deliverResult(machineId: string, result: { opId: string } & Record<string, unknown>) {
  const pending = pendingOps.get(result.opId);
  if (!pending || pending.machineId !== machineId) return;
  clearTimeout(pending.timer);
  pending.снятьAbort?.();
  pendingOps.delete(result.opId);
  // После отмены результат — уже никому: вызывающий получил «отменено».
  if (pending.cancelled) return;

  if (result.ok === true) {
    pending.resolve({
      ok: true,
      exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
      // Кадры — сам вывод. Поле в op_result берём только если кадров не было:
      // живой хост шлёт пустую строку, старый тест кладёт тот же текст в оба места.
      stdout: pending.stdoutChunks.length > 0
        ? pending.stdoutChunks.join("")
        : typeof result.stdout === "string" ? result.stdout : "",
      stderr: pending.stderrChunks.length > 0
        ? pending.stderrChunks.join("")
        : typeof result.stderr === "string" ? result.stderr : "",
      truncated: pending.truncated || result.truncated === true ? true : undefined,
      data: result.data,
    });
    return;
  }
  pending.resolve({
    ok: false,
    error:
      typeof result.error === "string"
        ? result.error
        : "хост не объяснил, что случилось",
    code: typeof result.code === "string" ? result.code : undefined,
  });
}

// Пинг хостов. Как и для приложения (pingAllClients в ws.ts): клиент после
// 45 с молчания считает канал мёртвым, поэтому в тишине сервер обязан сам
// себя обозначать. Молчание вместо ping снаружи читается как «сервер упал».
export function pingAllHosts() {
  for (const machineId of hostSockets.keys()) {
    sendToHost(machineId, { type: "ping" });
  }
}

let pingTimer: NodeJS.Timeout | null = null;

/** Запустить пинги. Один раз на процесс: и /host-ws, и тесты зовут входную
 *  точку шлюза, а второй таймер удвоил бы трафик и удвоил бы нагрузку на хост. */
export function startHostHeartbeat() {
  if (pingTimer) return;
  pingTimer = setInterval(pingAllHosts, HOST_PING_MS);
  pingTimer.unref?.();
}

/** Сбросить состояние шлюза. Только для тестов: в одном процессе живут
 *  десятки тестовых файлов, и сокет из одного теста иначе сделал бы машину
 *  «онлайн» в следующем. */
export function resetHostGatewaysForTests() {
  for (const [machineId, сокеты] of hostSockets) {
    hostSockets.delete(machineId);
    markMachineOffline(machineId);
    failPendingOps(machineId, new Error("тест сбросил шлюз"));
    сокеты.clear();
  }
  for (const [opId, pending] of [...pendingOps]) {
    clearTimeout(pending.timer);
    pendingOps.delete(opId);
  }
  pendingOps.clear();
}