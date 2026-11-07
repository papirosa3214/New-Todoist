// Глубокое исследование задачи — по ручной команде владельца.
//
// Владелец 21.09.2026, хэндофф HANDOFF-RESEARCHER-2026-09-21: порядок
// «план → сбор → валидация → синтез → отчёт» до сих пор жил только в
// промпте роли (`server/scripts/role-prompts/researcher.md`). Здесь он
// зафиксирован в КОДЕ: сервер сам гоняет шаги, повторяет сбор, пока
// валидация не скажет «достаточно» (с жёстким потолком раундов) и кладёт
// итог отчётом в карточку.
//
// Почему отдельным процессом. Сбор идёт минутами (сеть, OCR, локальная
// модель) — держать на этом HTTP-ответ нельзя. Ровно тот же приём, что у
// ручного запуска агента (`routes/manual-run.ts`): поднять детач-процесс и
// сразу ответить. Сам конвейер — `server/scripts/research_pipeline.py`.
//
// Гейты:
//   • команда только владельцу — это его инструмент, не самообслуживание
//     агентов;
//   • задача должна быть помечена `needs_research=1` (миграция 052) — иначе
//     конвейер пойдёт за источниками по рабочим пустякам;
//   • один активный прогон на задачу (в памяти процесса) — повторный тап
//     не поднимает второй обход.
//
// Токен дочернего процесса — короткоживущий JWT владельца (2 часа),
// подписанный тем же ключом, что и вход: конвейер ходит в API как владелец,
// поэтому не зависит от того, назначена ли задача агенту. Секретов в
// аргументах нет — JWT уходит только через окружение процесса.
import { spawn } from "child_process";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { getTaskForRead, isOwner } from "../access.js";

/** Путь к конвейеру относительно этого файла (server/src/routes → server/scripts). */
const PIPELINE = path.resolve(
  import.meta.dirname,
  "../../scripts/research_pipeline.py",
);

/** Что уже идёт прямо сейчас. Ключ — id задачи. В памяти процесса: рестарт
 *  сервера теряет отметку, но это < 2 часа и не стоит ещё одной таблицы. */
const running = new Set<string>();

export async function registerResearchRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/research",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!isOwner(req.userId)) {
        return reply
          .code(403)
          .send({ error: "глубокое исследование запускает только владелец" });
      }

      const task = getTaskForRead(req.params.id, req.userId) as
        | { id: string; needs_research?: number }
        | undefined;
      if (!task) return reply.code(404).send({ error: "Задача не найдена" });

      if (!task.needs_research) {
        return reply.code(400).send({
          error:
            "задача не помечена как «нужно глубокое исследование» — поставьте галочку в карточке",
        });
      }

      if (running.has(task.id)) {
        return reply
          .code(409)
          .send({ error: "исследование по этой задаче уже идёт" });
      }

      const owner = db
        .prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1")
        .get() as { id: string } | undefined;
      if (!owner) {
        return reply.code(500).send({ error: "владелец трекера не найден" });
      }

      // Короткоживущий токен владельца: конвейер ходит в API под ним, и
      // ему не нужно зависеть от назначения задачи.
      const token = (app as any).jwt.sign({ id: owner.id }, { expiresIn: "2h" });

      // Шов для тестов: подменить скрипт можно окружением, не трогая
      // боевой путь. В проде переменная не выставлена.
      const script = process.env.RESEARCH_PIPELINE_SCRIPT || PIPELINE;

      running.add(task.id);
      try {
        const child = spawn("/usr/bin/python3", [script, "--task", task.id], {
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            TASKFLOW_TOKEN: token,
            TASKFLOW_API: process.env.TASKFLOW_API || "http://localhost:3001",
          },
        });
        child.on("exit", () => running.delete(task.id));
        child.on("error", () => running.delete(task.id));
        child.unref();
      } catch (err) {
        running.delete(task.id);
        return reply
          .code(500)
          .send({ error: `не удалось запустить исследование: ${String(err)}` });
      }

      return { ok: true, started: true, task_id: task.id };
    },
  );

  // Что идёт по этой задаче прямо сейчас — карточке нужно показать, что
  // обход жив, а не «кнопка ничего не делает».
  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id/research",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      const task = getTaskForRead(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Задача не найдена" });
      return { running: running.has(req.params.id) };
    },
  );
}
