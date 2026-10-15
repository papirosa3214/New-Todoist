/**
 * Протокол связи сервера TaskFlow с машиной-хостом (тикет 1, план
 * taskflow-host, решение D3).
 *
 * Модуль общий: его импортирует и сервер, и хост с маке (тикет 2). Поэтому
 * здесь НИЧЕГО нет, кроме типов и маленьких функций-хелперов — ни одной
 * зависимости от Node, ни одного импорта серверных модулей. Иначе хост на маке
 * не смог бы взять файл протокола, не таща за собой пол-сервера.
 *
 * Кто кому что шлёт:
 *
 *   хост → сервер   hello        «я такой-то, вот мои корни и версия»
 *                   pong         ответ на ping (см. HOST_PING_MS)
 *                   op_chunk     кусок потока команды (stdout/stderr)
 *                   op_result    результат: успех с кодом выхода или ошибка
 *
 *   сервер → хост   welcome      приняли, вот твоя машина и её разрешённые корни
 *                   ping         «жив ли хост» — раз в HOST_PING_MS
 *                   op           вызов операции
 *                   op_cancel    отмена вызова
 *                   error        отказ (сейчас только unauthorized), дальше закрытие
 *
 * Поток отдельными сообщениями, а не одним большим, — потому что сборка Xcode
 * идёт минутами и молчащий вызов выглядел бы как зависший (план, «хрупкие
 * места»: протокол обязан нести поток, отмену и лимит вывода).
 */

/** Версия протокола. Хост сообщает свою в hello, сервер — в welcome.
 *  Растут несовместимо — поднимаем число, а не меняем смысл существующих полей. */
export const HOST_PROTOCOL_VERSION = 1;

/** Как часто сервер спрашивает хост «жив ли ты». В приложении это 20 с
 *  (KEEPALIVE_MS в ws.ts), и для хоста держим тот же ритм: телефон и хост —
 *  два клиента одного сервера. */
export const HOST_PING_MS = 20_000;

/** Потолок вывода одной операции. 4 МБ, как было у прежнего ssh-шлюза Xcode: без него
 *  `cat` большого файла съедает память процесса сервера, а «хост молчит»
 *  начинается только когда OOM-killer уже отработал. */
export const HOST_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Потолок времени одной операции. Сборка Xcode — минуты, но не вечность. */
export const HOST_DEFAULT_TIMEOUT_MS = 600_000;

/** Операции, которые сервер умеет просить у хоста. Их же тикет 3 будет
 *  навешивать на инструменты ролей: remoteOps.bash.exec → op "bash" и т.д.
 *  Закрытый список — не формальность: хост проверяет op по нему и отказывает
 *  на неизвестном, а не пытается выполнить что попало. */
export const HOST_OPERATIONS = [
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "git_worktree",
  // Push ветки роли в общий gitea: без него roleCommitCheck на .110 не увидит
  // работу, сделанную на маке, и отклонит закрытие шага (правка 12 плана).
  "git_push",
] as const;

export type HostOperation = (typeof HOST_OPERATIONS)[number];

export function isHostOperation(value: unknown): value is HostOperation {
  return (
    typeof value === "string" &&
    (HOST_OPERATIONS as readonly string[]).includes(value)
  );
}

/** Принимает ли хост операцию. */
export type HelloMessage = {
  type: "hello";
  protocolVersion?: number;
  /** Версия самого хоста (сборка программы), для разбора «хост старый». */
  hostVersion?: string;
  platform?: string;
  /** Корни, которые хост считает своими. Сервер сверяет их со своими:
   *  разрешённым остаётся ПЕРЕСЕЧЕНИЕ, иначе хост, раздавший `/`, разрешил бы
   *  операции везде, где сервер запретил. */
  roots?: string[];
};

export type PongMessage = { type: "pong" };

/**
 * «Ты принят, вот твоя машина и правила».
 *
 * Приходит ДВАЖДЫ, и это не опечатка:
 *   1. сразу после проверки ключа — с серверными корнями, чтобы хост, который
 *      ждёт ответа на подключение, не висел на своём таймауте;
 *   2. после `hello` хоста — с ПЕРЕСЕЧЕНИЕМ серверных и хостовых корней.
 * Второй welcome и есть окончательный: хост обязан считать разрешёнными
 * корни из последнего welcome, а не из первого.
 */
export type WelcomeMessage = {
  type: "welcome";
  protocolVersion: number;
  machineId: string;
  machineName: string;
  /** Разрешённые корни: пересечение серверных с корнями из hello. */
  allowedRoots: string[];
  /** Как часто ждать ping. */
  pingMs: number;
  /** Потолок времени одной операции — хост должен обрывать работу сам, а не висеть. */
  maxOutputBytes: number;
  defaultTimeoutMs: number;
};

export type PingMessage = { type: "ping" };

/** Вызов операции. args — по операции; сервер их не проверяет, это работа
 *  тикета 3 (он превращает аргументы инструмента в args). */
export type OpMessage = {
  type: "op";
  opId: string;
  op: HostOperation;
  args: Record<string, unknown>;
  timeoutMs?: number;
};

export type OpCancelMessage = { type: "op_cancel"; opId: string };

export type ErrorMessage = {
  type: "error";
  /** Пока один: ключ не подошёл или машина отозвана. Наружу разные причины
   *  не отдаются — иначе по сообщению можно перебором узнать, какие ключи
   *  выдавались. */
  error: "unauthorized";
};

export type OpChunkMessage = {
  type: "op_chunk";
  opId: string;
  stream: "stdout" | "stderr";
  data: string;
};

/** Результат операции. ok:false — это НЕ исключение сервера, а честный ответ
 *  «команда не вышла с нулём» или «пути нет»: вызывающий сам решает, что с этим
 *  делать (роль, например, читает текст ошибки). */
export type OpResultMessage =
  | {
      type: "op_result";
      opId: string;
      ok: true;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      /** Поток обрезан по HOST_MAX_OUTPUT_BYTES. */
      truncated?: boolean;
      /**
       * Результат операции объектом: у ls это {path, entries}, у read —
       * {content}, у find — {entries}. Без этого поля файловые операции
       * доезжали как «успех с пустым stdout», и роль на удалённой машине видела
       * бы пустой каталог и пустой файл вместо содержимого.
       */
      data?: unknown;
    }
  | {
      type: "op_result";
      opId: string;
      ok: false;
      error: string;
      code?: string;
    };

export type ServerToHost =
  | WelcomeMessage
  | PingMessage
  | OpMessage
  | OpCancelMessage
  | ErrorMessage;

export type HostToServer =
  | HelloMessage
  | PongMessage
  | OpChunkMessage
  | OpResultMessage;

/**
 * Разобрать сообщение хоста. Отдаёт null на всём, что не разобрано: хост —
 * чужая программа на чужой машине, и падать из-за её мусора сервер не должен.
 */
export function parseHostMessage(raw: unknown): HostToServer | null {
  let сообщение: any = raw;
  if (typeof raw === "string") {
    try {
      сообщение = JSON.parse(raw);
    } catch {
      return null;
    }
  } else if (raw && typeof raw === "object" && "toString" in raw) {
    // ws отдаёт Buffer; на нём JSON.parse не сработает.
    try {
      сообщение = JSON.parse(String(raw));
    } catch {
      return null;
    }
  }
  if (!сообщение || typeof сообщение !== "object") return null;

  switch (сообщение.type) {
    case "hello":
      return {
        type: "hello",
        protocolVersion: Number(сообщение.protocolVersion) || undefined,
        hostVersion:
          typeof сообщение.hostVersion === "string"
            ? сообщение.hostVersion
            : undefined,
        platform:
          typeof сообщение.platform === "string"
            ? сообщение.platform
            : undefined,
        roots: Array.isArray(сообщение.roots)
          ? сообщение.roots.map(String)
          : undefined,
      };
    case "pong":
      return { type: "pong" };
    case "op_chunk":
      if (typeof сообщение.opId !== "string") return null;
      return {
        type: "op_chunk",
        opId: сообщение.opId,
        stream: сообщение.stream === "stderr" ? "stderr" : "stdout",
        data: typeof сообщение.data === "string" ? сообщение.data : "",
      };
    case "op_result":
      if (typeof сообщение.opId !== "string") return null;
      return сообщение.ok === true
        ? {
            type: "op_result",
            opId: сообщение.opId,
            ok: true,
            exitCode:
              typeof сообщение.exitCode === "number" ? сообщение.exitCode : 0,
            stdout:
              typeof сообщение.stdout === "string" ? сообщение.stdout : "",
            stderr:
              typeof сообщение.stderr === "string" ? сообщение.stderr : "",
            truncated: сообщение.truncated === true ? true : undefined,
            data: сообщение.data,
          }
        : {
            type: "op_result",
            opId: сообщение.opId,
            ok: false,
            error:
              typeof сообщение.error === "string"
                ? сообщение.error
                : "хост не объяснил, что случилось",
            code: typeof сообщение.code === "string" ? сообщение.code : undefined,
          };
    default:
      return null;
  }
}

/**
 * Пересечение разрешённых корней сервера и корней хоста.
 *
 * Берётся пересечение, а не серверные: хост — чужая программа, и объявлять
 * свой корень может что угодно. Если пересечение пусто, машина формально
 * онлайн, но ни одну операцию не выполнит — это лучше, чем молчаливая работа
 * во всех папках подряд.
 */
export function intersectRoots(
  серверные: string[],
  хостовые: string[] | undefined,
): string[] {
  if (!хостовые || хостовые.length === 0) return [...серверные];
  const разрешённые = new Set(серверные.map(normalizeRoot));
  return хостовые
    .map(normalizeRoot)
    .filter((корень) => {
      // Корень хоста подходит, только если сервер разрешил этот путь ИЛИ его
      // родителя: хост может разрешить /Users/max/Проекты, а сервер — /Users/max.
      let текущий = корень;
      for (;;) {
        if (разрешённые.has(текущий)) return true;
        const родитель = pathPosixDirname(текущий);
        if (!родитель) return false;
        текущий = родитель;
      }
    });
}

/** Схлопывает путь до канонического вида: без хвостового слэша и без `/./`.
 *  Без этого `/Users/max` и `/Users/max/` считались бы разными корнями. */
function normalizeRoot(root: string): string {
  const trimmed = root.trim().replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function pathPosixDirname(p: string): string | null {
  const normalized = normalizeRoot(p);
  if (normalized === "/") return null;
  const индекс = normalized.lastIndexOf("/");
  if (индекс <= 0) return "/";
  return normalized.slice(0, индекс);
}