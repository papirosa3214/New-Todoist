// Тумблер автономного режима: включить/выключить службу-будильник.
//
// Зачем: два режима работы агента переключались только из терминала
// (`systemctl --user start|stop taskflow-trigger`), а решать это нужно на
// ходу и с телефона. Смысл режимов — см. AGENT-PROTOCOL.md:
//   включено  — автономка: назначил задачу и ушёл, будильник поднимает
//               двойника, тот работает сам и сам шлёт сигналы аренды;
//   выключено — совместная работа: задачи берёт живая сессия, аренда
//               продлевается вручную, статус спрашивается в разговоре.
//
// Почему здесь можно дёргать systemd: сервер запущен под тем же
// пользователем, что и юнит (--user), никаких повышений прав не нужно.
// Имя юнита захардкожено, аргументы от клиента в команду не попадают —
// принимается только «включить» или «выключить».
import type { FastifyInstance } from "fastify";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { authOrApiToken } from "../auth.js";
import { isOwner, isOrchestrator } from "../access.js";

const run = promisify(execFile);

const UNIT = "taskflow-trigger";

// Сторож будильника ходит парой с самим будильником. Он раз в 10 минут
// проверяет, жив ли UNIT, и сторожить выключенную службу бессмысленно:
// 09.09.2026 владелец выключил автономку тумблером, а сторож остался
// включённым и весь день сыпал ошибкой в журнал, из-за чего infra-панель
// висела в «critical» — в таком шуме настоящую поломку не разглядеть.
const WATCH_UNIT = "taskflow-trigger-watch.timer";

/** Живое состояние юнита: работает ли сейчас и включён ли автозапуск.
 *
 *  Экспортируется для /api/roles: статус роли зависит от того, жив ли
 *  вообще исполнитель, и спрашивать об этом надо в одном месте — иначе
 *  два экрана начнут по-разному считать, работает ли автономка. */
// Период обхода доски будильником. Зашит в scripts/trigger.py
// (BOARD_SCAN_SEC, строка ~809) — здесь повторён только чтобы показать
// владельцу обратный отсчёт. Меняешь там — поменяй и тут, иначе таймер на
// экране разойдётся с настоящим обходом.
const BOARD_SCAN_SEC = 3 * 60;

/** Момент, когда будильник в последний раз отметился живым.
 *
 *  Пишется самим триггером раз в 30 секунд в файл состояния. Читаем его, а
 *  не только systemd: служба может числиться active, уже не подавая
 *  признаков жизни, и владельцу важнее второе. */
function lastAliveAt(): string | null {
  try {
    const raw = readFileSync(
      join(homedir(), ".local/state/taskflow-trigger/alive"),
      "utf8",
    ).trim();
    const at = new Date(raw);
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
  } catch {
    return null;
  }
}

/** Ближайший обход доски, считая от момента запуска службы.
 *
 *  Триггер обходит доску ровно раз в BOARD_SCAN_SEC, начиная спустя тот же
 *  интервал после старта (board_scan_loop: sleep, обход, sleep). Поэтому
 *  точку отсчёта берём у systemd, а не гадаем. */
function nextScanAt(activeEnter: string): string | null {
  const started = new Date(activeEnter);
  if (Number.isNaN(started.getTime())) return null;
  const elapsed = (Date.now() - started.getTime()) / 1000;
  const passed = Math.floor(elapsed / BOARD_SCAN_SEC) + 1;
  return new Date(
    started.getTime() + passed * BOARD_SCAN_SEC * 1000,
  ).toISOString();
}

export async function unitState(): Promise<{
  active: boolean;
  enabled: boolean;
  last_alive_at: string | null;
  next_scan_at: string | null;
  scan_interval_sec: number;
}> {
  try {
    const { stdout } = await run("systemctl", [
      "--user",
      "show",
      UNIT,
      "-p",
      "ActiveState,UnitFileState,ActiveEnterTimestamp",
    ]);
    const active = /ActiveState=active/.test(stdout);
    const enabled = /UnitFileState=enabled/.test(stdout);
    // systemd отдаёт «Tue 2026-09-16 05:40:43 MSK» — Date такое разбирает
    // только с оговорками, поэтому вытаскиваем дату и время явно и считаем
    // их локальными: юнит и сервер живут в одном часовом поясе.
    const m = stdout.match(
      /ActiveEnterTimestamp=\w{3} (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/,
    );
    const startedLocal = m ? m[1].replace(" ", "T") : "";
    return {
      active,
      enabled,
      last_alive_at: lastAliveAt(),
      next_scan_at: active && startedLocal ? nextScanAt(startedLocal) : null,
      scan_interval_sec: BOARD_SCAN_SEC,
    };
  } catch {
    // Юнита нет вовсе или systemd недоступен — для интерфейса это
    // «выключено», а не ошибка: тумблер просто останется в левом положении.
    return {
      active: false,
      enabled: false,
      last_alive_at: null,
      next_scan_at: null,
      scan_interval_sec: BOARD_SCAN_SEC,
    };
  }
}

export function registerAgentServiceRoutes(app: FastifyInstance) {
  app.get(
    "/api/agent-service",
    { preHandler: authOrApiToken },
    async () => await unitState(),
  );

  app.post<{ Body: { on?: boolean } }>(
    "/api/agent-service",
    // Шаг 5 ТЗ docs/taskflow-direct-dispatch-mvp.md: владелец может
    // включать/выключать службу. Агентский API-token не должен иметь такой
    // ручки.
    //
    // Расширение 11.09.2026 (карточка b6b57092, согласовано с владельцем):
    // тумблер автономки также доступен учётке с role='orchestrator' — это
    // узкая строка матрицы прав, а не пересмотр решения 08.09.2026 об
    // оркестраторе (закрытие/возврат задачи остаются только за владельцем).
    // Сторож по-прежнему не имеет права — учётки типа 'ai' сюда не пройдут
    // уже на authOrApiToken (там стоит проверка на DELETE для всех ИИ, а
    // /api/agent-service — не DELETE, но agent-токен всё равно отбивается
    // дальше isOwner/isOrchestrator).
    //
    // authOrApiToken на успехе возвращает undefined и ставит userId в req
    // (см. auth.ts:172-201). reply.sent=true означает «уже ответили 401» —
    // дальше идти некуда. Иначе — берём userId из req и проверяем
    // isOwner() / isOrchestrator() из access.ts.
    {
      preHandler: async (req: any, reply) => {
        await authOrApiToken(req, reply);
        if (reply.sent) return;
        const userId = (req as any).userId;
        if (!userId || (!isOwner(userId) && !isOrchestrator(userId))) {
          return reply.code(403).send({ error: "owner_or_orchestrator_only" });
        }
      },
    },
    async (req: any, reply) => {
      if (typeof req.body?.on !== "boolean") {
        return reply.code(400).send({ error: "Ожидается поле on: true|false" });
      }

      // enable/disable вместе со start/stop — чтобы выбор пережил
      // перезагрузку машины. Иначе автономка молча выключалась бы после
      // каждого рестарта, а на доске это выглядит как «агент пропал».
      const verb = req.body.on ? "enable" : "disable";

      try {
        await run("systemctl", ["--user", verb, "--now", UNIT]);
      } catch (e: any) {
        return reply.code(500).send({
          error: "Не удалось переключить службу",
          detail: String(e?.stderr || e?.message || e).slice(0, 300),
        });
      }

      // Сторож — следом за будильником, но его сбой тумблер не роняет:
      // главное здесь автономка, а сторож лишь присматривает за ней.
      // Гасим и накопленную отметку об ошибке, иначе выключенный сторож
      // остаётся в журнале как failed и панель продолжает считать это
      // поломкой.
      try {
        await run("systemctl", ["--user", verb, "--now", WATCH_UNIT]);
        if (!req.body.on) {
          await run("systemctl", [
            "--user",
            "reset-failed",
            "taskflow-trigger-watch.service",
          ]).catch(() => {});
        }
      } catch (e: any) {
        req.log?.warn(
          { err: String(e?.stderr || e?.message || e) },
          `Не удалось ${verb} сторож ${WATCH_UNIT}`,
        );
      }

      // ok: true — подтверждение того, что переключение действительно
      // выполнено, а не просто «вот текущее состояние». GET возвращает
      // те же active/enabled без ok, и без этого флага клиент не отличал
      // успешную мутацию от обычного чтения: тумблер в интерфейсе мог
      // отрисовать старое положение как подтверждённое.
      return { ok: true, ...(await unitState()) };
    },
  );
}
