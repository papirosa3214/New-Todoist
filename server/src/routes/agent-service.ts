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
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";

const run = promisify(execFile);

const UNIT = "taskflow-trigger";

/** Живое состояние юнита: работает ли сейчас и включён ли автозапуск. */
async function unitState(): Promise<{ active: boolean; enabled: boolean }> {
  try {
    const { stdout } = await run("systemctl", [
      "--user",
      "show",
      UNIT,
      "-p",
      "ActiveState,UnitFileState",
    ]);
    const active = /ActiveState=active/.test(stdout);
    const enabled = /UnitFileState=enabled/.test(stdout);
    return { active, enabled };
  } catch {
    // Юнита нет вовсе или systemd недоступен — для интерфейса это
    // «выключено», а не ошибка: тумблер просто останется в левом положении.
    return { active: false, enabled: false };
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
    // Шаг 5 ТЗ docs/taskflow-direct-dispatch-mvp.md: только владелец
    // может включать/выключать службу. Агентский API-token не должен
    // иметь такой ручки.
    //
    // authOrApiToken на успехе возвращает undefined и ставит userId в req
    // (см. auth.ts:172-201). reply.sent=true означает «уже ответили 401» —
    // дальше идти некуда. Иначе — берём userId из req и проверяем
    // isOwner() из access.ts.
    { preHandler: async (req: any, reply) => {
        await authOrApiToken(req, reply);
        if (reply.sent) return;
        const userId = (req as any).userId;
        if (!userId || !isOwner(userId)) {
          return reply.code(403).send({ error: "owner_only" });
        }
      } },
    async (req: any, reply) => {
      if (typeof req.body?.on !== "boolean") {
        return reply.code(400).send({ error: "Ожидается поле on: true|false" });
      }

      // enable/disable вместе со start/stop — чтобы выбор пережил
      // перезагрузку машины. Иначе автономка молча выключалась бы после
      // каждого рестарта, а на доске это выглядит как «агент пропал».
      const args = req.body.on
        ? ["--user", "enable", "--now", UNIT]
        : ["--user", "disable", "--now", UNIT];

      try {
        await run("systemctl", args);
      } catch (e: any) {
        return reply.code(500).send({
          error: "Не удалось переключить службу",
          detail: String(e?.stderr || e?.message || e).slice(0, 300),
        });
      }

      return await unitState();
    },
  );
}