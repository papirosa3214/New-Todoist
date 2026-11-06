/**
 * Запрет опасных остановок процессов в bash роли.
 *
 * Владелец 06.11.2026: роль builder в чате прибирала за своей пробой и
 * выполнила `pkill -f "dist/index.js" -u maksim` — под шаблон попал рабочий
 * сервер (тот же `node dist/index.js` того же пользователя), он упал посреди
 * работы, у владельца «Не удалось загрузить чаты». Bash чатового хода
 * исполняется от пользователя сервера (не изолирован, как рабочий ход), поэтому
 * такие команды отсекаются до запуска:
 *  - остановка по шаблону: pkill, killall, fuser -k, kill по pgrep/pidof,
 *    `… | xargs kill`;
 *  - kill самого сервера, `kill -1`, `kill 0` (все процессы пользователя).
 * Свой процесс по номеру (`kill $PID`, `kill 12345`) — можно.
 *
 * Разбор грубый и намеренно осторожный: команда делится на части по `;`, `&`,
 * `|` и переводам строк, в каждой смотрится только сама команда после обёрток
 * (sudo, nohup, timeout, env, exec, xargs, присваивания). Аргументы других
 * команд (`grep pkill`, `echo 'killall'`) не проверяются.
 */

const PATTERN_KILL =
  "Остановка процессов по шаблону (pkill, killall, fuser -k, kill по pgrep/pidof, xargs kill) запрещена: " +
  "под шаблон попадает рабочий сервер TaskFlow, он запущен тем же `node dist/index.js` от того же пользователя. " +
  "Останавливай только свой процесс по номеру: запомни PID при запуске (`$!`) и выполни `kill <номер>`.";

const SERVER_KILL =
  "Это остановка рабочего сервера TaskFlow (или всех процессов пользователя) — роли так делать нельзя. " +
  "Останавливай только свой процесс по номеру: запомни PID при запуске (`$!`) и выполни `kill <номер>`.";

const WRAPPERS = new Set(["sudo", "nohup", "exec", "command", "builtin", "setsid", "env", "nice", "ionice", "stdbuf", "time"]);

function words(segment: string): string[] {
  return segment.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^["']|["']$/g, ""));
}

/** Сама команда части: без присваиваний и обёрток. */
function commandWords(segment: string): string[] {
  let w = words(segment);
  for (;;) {
    if (!w.length) return w;
    const head = w[0].replace(/^.*\//, "");
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) { w = w.slice(1); continue; }
    if (head === "timeout") { w = w.slice(1); while (w.length && /^-|^\d/.test(w[0])) w = w.slice(1); continue; }
    if (head === "xargs") { w = w.slice(1); while (w.length && w[0].startsWith("-")) w = w.slice(1); continue; }
    if (WRAPPERS.has(head)) {
      w = w.slice(1);
      // `sudo -u user`, `nice -n 5` — опция со значением.
      while (w.length && w[0].startsWith("-")) {
        const opt = w[0];
        w = w.slice(1);
        if (/^-(u|g|n|c|o)$/.test(opt) && w.length) w = w.slice(1);
      }
      continue;
    }
    return w;
  }
}

/** Цели `kill` (без сигнала и опций). */
function killTargets(args: string[]): string[] {
  const targets: string[] = [];
  let signalTaken = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { targets.push(...args.slice(i + 1)); break; }
    if (!signalTaken && (a === "-s" || a === "-n")) { signalTaken = true; i++; continue; }
    if (!signalTaken && /^-[A-Za-z0-9]+$/.test(a) && !/^-\d+$/.test(a) || (!signalTaken && /^-\d+$/.test(a) && targets.length === 0 && i === 0)) {
      signalTaken = true;
      continue;
    }
    targets.push(a);
  }
  return targets;
}

/** Причина отказа или null, если команду можно выполнять. */
export function roleBashKillError(command: unknown, serverPid: number = process.pid): string | null {
  if (typeof command !== "string" || !command.trim()) return null;
  for (const segment of command.split(/;|&&|\|\||\||&|\n/)) {
    const w = commandWords(segment);
    if (!w.length) continue;
    const head = w[0].replace(/^.*\//, "");
    if (head === "pkill" || head === "killall") return PATTERN_KILL;
    if (head === "fuser" && w.slice(1).some((a) => /^-[a-zA-Z]*k/.test(a))) return PATTERN_KILL;
    if (head !== "kill") continue;
    const rest = w.slice(1);
    if (rest.some((a) => /pgrep|pidof/.test(a)) || /\$\((\s*)(pgrep|pidof)|`\s*(pgrep|pidof)/.test(segment)) return PATTERN_KILL;
    const targets = killTargets(rest);
    // `… | xargs kill` — номера приходят из соседней части по шаблону.
    if (!targets.length && /\bxargs\b/.test(segment)) return PATTERN_KILL;
    for (const t of targets) {
      if (t === "-1" || t === "0" || t === "-0") return SERVER_KILL;
      if (t === String(serverPid) || t === `-${serverPid}`) return SERVER_KILL;
    }
  }
  return null;
}

type BashToolLike = { name: string; execute: (...args: any[]) => Promise<any> };

/** Обёртка bash роли: опасная остановка отклоняется до запуска команды. */
export function withRoleBashKillGuard<T extends BashToolLike>(tool: T): T {
  if (tool.name !== "bash") return tool;
  const original = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (toolCallId: string, params: any, ...rest: any[]) => {
      const reason = roleBashKillError(params?.command);
      if (reason) throw new Error(reason);
      return original(toolCallId, params, ...rest);
    },
  } as T;
}
