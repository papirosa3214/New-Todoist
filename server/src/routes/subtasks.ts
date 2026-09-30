import { effectiveRules } from "../lib/roleContextResolver.js";
import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";
import { unlockReadyPlanSubtasks } from "../runtime/planSubtaskAdmission.js";
import { bumpContextVersion } from "../runtime/taskContextVersion.js";
import { authOrApiToken, sessionOf } from "../auth.js";
import { getTaskForRead, getTaskForWrite } from "../access.js";
import { broadcastToUsers, broadcastTaskEvent } from "../ws.js";
import {
  AGENT_RULES,
  logEvent,
  isStale,
  subtaskWorkRefusal,
  RESULT_MAX,
  SUBTASK_TITLE_MAX,
} from "../agentState.js";
// Тот же расчёт state/agent_stale, что у GET /api/tasks/:id (tasks.ts) —
// иначе ответы этого файла (add/patch/delete подзадачи, WS-рассылка)
// отдают сырой agent_state вместо вычисленного state, и два места отдачи
// задачи расходятся в контракте. Максим 18.08.2026: «почини».
import { withSubtaskState, getTaskRow } from "./tasks.js";
import { readAttemptId, attemptMismatchReason } from "../lib/attemptCheck.js";
import { currentResultVersion, ensureResultVersionForReview, resultFromSubtasks } from "../resultVersions.js";
import { enqueueRoleRunJob } from "../runtime/roleRunQueue.js";

const uid = () => crypto.randomUUID();

/** Get full task state with assignee info, labels, subtasks, and comments. */
export function getFullTask(taskId: string) {
  const full = getTaskRow(taskId);
  if (!full) return undefined;

  const labels = db
    .prepare(
      `SELECT l.* FROM labels l JOIN task_labels tl ON tl.label_id = l.id WHERE tl.task_id = ?`,
    )
    .all(taskId);
  const subtasks = db
    .prepare("SELECT * FROM subtasks WHERE task_id = ? ORDER BY position")
    .all(taskId)
    .map(withSubtaskState);
  const comments = db
    .prepare(
      `SELECT c.*, u.name as user_name, u.avatar_color as user_color, u.avatar_url as user_avatar_url, u.initials as user_initials
       FROM comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.task_id = ? ORDER BY c.created_at`,
    )
    .all(taskId);

  return { ...full, labels, subtasks, comments };
}

/**
 * Подзадача вместе с её задачей — и только если вызывающий вправе эту задачу
 * ПРАВИТЬ. Предикат владения больше не зашит в запрос: правило зависит от
 * роли (владельцу — любая задача, агенту — своя), и живёт оно в одном месте,
 * в access.ts. Раньше здесь стояло собственное `creator_id = ? OR
 * assignee_id = ?`, из-за чего владелец не мог тронуть шаг в задаче,
 * которую агент завёл сам.
 */
export function getSubtaskWithTaskForUser(
  subtaskId: string,
  userId: string,
): any | undefined {
  const subtask = db
    .prepare(
      `SELECT s.*, t.creator_id as task_creator_id, t.assignee_id as task_assignee_id,
              t.agent_state as task_agent_state, t.current_attempt_id as task_current_attempt_id
       FROM subtasks s JOIN tasks t ON t.id = s.task_id
       WHERE s.id = ?`,
    )
    .get(subtaskId) as any;
  if (!subtask) return undefined;
  return getTaskForRead(subtask.task_id, userId) ? subtask : undefined;
}

export function registerSubtaskCommentRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // ── Subtasks ── all scoped to a task the caller may access (creator or assignee).
  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/subtasks",
    { preHandler: authPre },
    async (req: any, reply) => {
      const task = getTaskForRead(req.params.taskId, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });
      return db
        .prepare("SELECT * FROM subtasks WHERE task_id = ? ORDER BY position")
        .all(req.params.taskId);
    },
  );

  app.post<{
    Params: { taskId: string };
    Body: { title: string; after_id?: string };
  }>("/api/tasks/:taskId/subtasks", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const task = getTaskForWrite(req.params.taskId, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });

      // У РОДИТЕЛЯ СВОИХ ШАГОВ НЕТ (10.09.2026, задача a195895d).
      //
      // Разбиение родительской задачи — это её дочерние карточки. Заводя
      // ей ещё и чек-лист, мы получаем два списка одного и того же: по
      // какому из них считать прогресс и что считать «последней закрытой
      // единицей работы» — становится непонятно, а от этого зависит
      // автопереход на приёмку.
      //
      // Запрет только на ДОБАВЛЕНИЕ: шаги, заведённые до появления детей,
      // остаются и закрываются как раньше — иначе правка задним числом
      // ломала бы уже идущую работу.
      const hasChildren = db
        .prepare("SELECT 1 FROM tasks WHERE parent_id = ? LIMIT 1")
        .get(req.params.taskId);
      if (hasChildren) {
        return reply.code(400).send({
          error:
            "у задачи есть дочерние — её разбиение это они, отдельные шаги ей не заводятся. " +
            "Нужен ещё пункт работы — заведите дочернюю задачу",
        });
      }

      if (!req.body?.title)
        return reply.code(400).send({ error: "title required" });
      // Предел на заголовок шага — про агентов, чтобы чек-лист оставался
      // коротким пунктом работы, а не абзацем. Владелец 26.09.2026 упёрся
      // в него сам, дописывая шаг руками в уже закрытую карточку — лимит,
      // не различавший вызывающего, ловил и его тоже. Человека это не
      // касается, тем же приёмом, что и предел на result при закрытии.
      const titleCaller = db
        .prepare("SELECT type FROM users WHERE id = ?")
        .get(req.userId) as { type?: string } | undefined;
      if (
        titleCaller?.type === "ai" &&
        req.body.title.length > SUBTASK_TITLE_MAX
      ) {
        return reply.code(400).send({
          error: `title слишком длинный (max ${SUBTASK_TITLE_MAX})`,
        });
      }

      const id = uid();

      // after_id: агент вставляет шаг НЕ в конец, а сразу после конкретного
      // уже существующего — например, между шагом 2 и 3, поняв по ходу
      // работы, что нужен ещё один. Без него — прежнее поведение (в конец).
      // Позиция сдвигается транзакцией: и освобождение места, и сама
      // вставка коммитятся вместе, иначе конкурентный запрос может
      // воткнуться между ними и увидеть дыру или дубль.
      const afterId = req.body.after_id;
      if (afterId) {
        const after = db
          .prepare("SELECT * FROM subtasks WHERE id = ? AND task_id = ?")
          .get(afterId, req.params.taskId) as any;
        if (!after) {
          return reply
            .code(400)
            .send({ error: "after_id: подзадача не найдена в этой задаче" });
        }
        db.transaction(() => {
          db.prepare(
            "UPDATE subtasks SET position = position + 1 WHERE task_id = ? AND position > ?",
          ).run(req.params.taskId, after.position);
          db.prepare(
            "INSERT INTO subtasks (id, task_id, title, position) VALUES (?,?,?,?)",
          ).run(id, req.params.taskId, req.body.title, after.position + 1);
        })();
      } else {
        const maxPos = db
          .prepare(
            "SELECT COALESCE(MAX(position),0) as m FROM subtasks WHERE task_id = ?",
          )
          .get(req.params.taskId) as any;
        db.prepare(
          "INSERT INTO subtasks (id, task_id, title, position) VALUES (?,?,?,?)",
        ).run(id, req.params.taskId, req.body.title, maxPos.m + 1);
      }
      const subtask = withSubtaskState(
        db.prepare("SELECT * FROM subtasks WHERE id = ?").get(id),
      );

      logEvent({
        taskId: req.params.taskId,
        actorId: req.userId,
        kind: "subtask_added",
        field: "subtask",
        toValue: req.body.title,
      });

      const fullTask = getFullTask(req.params.taskId);
      broadcastTaskEvent([task.creator_id, task.assignee_id], {
        type: "task:updated",
        task: fullTask,
      });
      return subtask;
    },
  });

  app.patch<{
    Params: { id: string };
    Body: {
      done?: boolean;
      title?: string;
      position?: number;
      result?: string;
    };
  }>("/api/subtasks/:id", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const subtask = getSubtaskWithTaskForUser(req.params.id, req.userId);
      if (!subtask) return reply.code(404).send({ error: "Not found" });

      const { done, title, position, result } = req.body || {};
      if (position !== undefined && !Number.isInteger(position)) {
        return reply.code(400).send({ error: "position must be an integer" });
      }

      // ЗАКРЫТИЕ ШАГА АГЕНТОМ ОБЯЗАНО НЕСТИ ИТОГ.
      //
      // Отменяя приёмку (20.08.2026), мы вместе с ней потеряли `result`:
      // раньше «что вышло» требовалось при сдаче в review, а закрытие
      // галочкой такого поля вообще не принимало. Максим в тот же вечер:
      // «ты комментарий перестал писать при закрытии этих подзадач».
      //
      // Владельцу отметка нужна не сама по себе, а как ответ на «что
      // сделано»: без него в ленте остаётся ряд галочек, по которому нельзя
      // ни оценить работу, ни вернуться к ней через месяц. Так что приёмку
      // мы сняли, а отчётность — нет.
      //
      // Человека это не касается: он закрывает шаги руками в своём
      // интерфейсе, и требовать от него текст в каждой галочке — та самая
      // лишняя работа, от которой уходили.
      if (done === true) {
        const caller = db
          .prepare("SELECT type FROM users WHERE id = ?")
          .get(req.userId) as { type?: string } | undefined;
        if (caller?.type === "ai") {
          // ШАГ ЗАКРЫВАЕТСЯ ТОЛЬКО ИЗ РАБОТЫ — прогресс нельзя пропустить.
          //
          // Максим 10.09.2026, второй раз за сессию: «опять же, прогресс не
          // ставишь». Агент делал работу и сразу ставил галочку, поэтому на
          // доске не крутился ни один шаг: владелец смотрит карточку и не
          // понимает, идёт ли что-то прямо сейчас и какой именно пункт.
          //
          // Просьбой в правилах это не держалось — правила агент читает и
          // всё равно пропускает шаг под спешку. Держим сервером, там же,
          // где уже стоит требование `result`: закрыть шаг можно, только
          // если он был отмечен в работе (agent_state='in_progress'), и
          // отметку ставил ТОТ ЖЕ исполнитель. Чужую работу закрыть за
          // человека нельзя — иначе отметка превращается в формальность.
          //
          // Владельца это не касается: он закрывает шаги руками, и ветка
          // целиком под `caller.type === 'ai'`.
          if (subtask.agent_state !== "in_progress") {
            return reply.code(400).send({
              error:
                "шаг нельзя закрыть, не взяв его в работу: сначала " +
                'POST /api/subtasks/:id/work {"state":"in_progress"}, ' +
                "иначе на доске не видно, какой пункт идёт прямо сейчас",
            });
          }
          if (subtask.agent_id && subtask.agent_id !== req.userId) {
            return reply.code(409).send({
              error:
                "шаг в работе у другого исполнителя — закрывает тот, кто его вёл",
            });
          }
          if (!result && !subtask.result) {
            return reply.code(400).send({
              error:
                "result обязателен при закрытии шага: одно-два предложения, что сделано",
            });
          }
          // Предел длины переехал сюда вместе с самим закрытием: раньше он
          // стоял на сдаче шага в review, а с 21.08.2026 агенту этот путь
          // закрыт — шаги он закрывает галочкой. Без переноса ограничение
          // просто перестало бы действовать, и в карточке снова копились бы
          // выдержки из аудита вместо человеческого «что вышло».
          if ((result ?? "").length > RESULT_MAX) {
            return reply.code(400).send({
              error:
                `result слишком длинный (${result.length} символов при пределе ${RESULT_MAX}). ` +
                "Владельцу нужно одно-два предложения по-человечески: что в итоге " +
                "сделано, чтобы он мог оценить факт выполнения. Технические " +
                "детали и выдержки из аудита — в базу знаний, не в карточку.",
            });
          }
        }
      }
      if (result !== undefined) {
        db.prepare("UPDATE subtasks SET result = ? WHERE id = ?").run(
          result || null,
          subtask.id,
        );
      }
      // Шаг закрывает тот, кто его сделал, — включая агента.
      //
      // Утром 20.08.2026 здесь стоял обратный запрет: агент обязан был
      // сдавать шаг на приёмку владельцу. К вечеру того же дня Максим
      // отменил его, поработав по этому конвейеру руками: «понту мне вот
      // эту проверку делать особой нет — если ты выполнил, я посмотрю, мне
      // что-то не нравится, я комментарий напишу или новую задачу создам.
      // Это лишнее телодвижение, убирай ревью из процессов».
      //
      // Контроль качества никуда не делся, он просто переехал: владелец
      // смотрит РЕЗУЛЬТАТ и заводит новую работу, если тот не устраивает,
      // вместо того чтобы прощёлкивать галочки за агентом. `result` («что
      // вышло») и состояние review остаются доступными — они полезны,
      // когда шаг правда нужно показать до закрытия, — но обязательными
      // больше не являются.
      if (done !== undefined) {
        db.prepare("UPDATE subtasks SET done = ? WHERE id = ?").run(
          done ? 1 : 0,
          req.params.id,
        );
        // ЗАКРЫТЫЙ ШАГ НЕ МОЖЕТ БЫТЬ «В РАБОТЕ» — гасим отметку здесь же.
        //
        // Раньше done менял только свою колонку, а agent_state, исполнитель
        // и аренда оставались на шаге навсегда. На чтении это маскировалось
        // (фильтр !s.done в withAgentStale, state='done' в withSubtaskState),
        // поэтому и жило незамеченным — до вечера 20.08.2026, когда Максим
        // снял галочку с закрытого шага: остаток ожил, и давно доделанная
        // работа снова показалась идущей, хотя задача стояла в blocked.
        //
        // Снимаем ровно те же три поля, что и явное «отпустить шаг»
        // (state: null ниже). Отдельного события в ленту не пишем —
        // subtask_done уже сказал всё, что владельцу нужно знать.
        // Обратный случай (done=false, владелец вернул шаг) не трогаем:
        // отметки на шаге к этому моменту уже нет, а взяться заново — дело
        // исполнителя.
        if (done === true) {
          db.prepare(
            "UPDATE subtasks SET agent_state = NULL, agent_id = NULL, agent_heartbeat_at = NULL WHERE id = ?",
          ).run(req.params.id);
        }
        // Галочка на шаге — такое же событие задачи, как и всё остальное:
        // в ленте видно, кто именно отметил шаг сделанным (или снял
        // отметку). Пишем только при реальной смене, чтобы повторный
        // PATCH тем же значением не плодил одинаковые строки.
        if (!!subtask.done !== !!done) {
          logEvent({
            taskId: subtask.task_id,
            actorId: req.userId,
            kind: done ? "subtask_done" : "subtask_undone",
            field: "subtask",
            toValue: title ?? subtask.title,
          });
        }

        // ЗАКРЫТ ПОСЛЕДНИЙ ШАГ — ЗАДАЧА САМА УХОДИТ НА ПРИЁМКУ.
        //
        // До 10.09.2026 (задача a195895d) этот переход был ручным: агент
        // закрывал шаги, а потом отдельным действием переводил задачу в
        // review. Забыл — карточка висела «в работе» с полностью закрытыми
        // шагами, и владелец не понимал, ждать ему ещё или уже смотреть.
        // В лентах такое встречалось не раз.
        //
        // Это тот же принцип, что у родителя-зонтика в tasks.ts: закрылась
        // последняя единица работы — результат сам доезжает до стола
        // владельца. Закрывает задачу по-прежнему только он.
        //
        // ТОЛЬКО ДЛЯ ЗАДАЧИ, КОТОРУЮ ВЕДЁТ АГЕНТ (agent_state =
        // 'in_progress'). Свои задачи владелец ведёт без агента вовсе, и
        // отправлять их «на приёмку» самому себе — ровно та канитель, от
        // которой уходим: человек закрыл последний пункт списка покупок и
        // получил карточку в состоянии «жду проверки».
        if (done === true) {
          const parentTask = db
            .prepare("SELECT id, status, agent_state FROM tasks WHERE id = ?")
            .get(subtask.task_id) as
            | { id: string; status: string; agent_state: string | null }
            | undefined;
          if (
            parentTask &&
            parentTask.status === "active" &&
            parentTask.agent_state === "in_progress"
          ) {
            const open = db
              .prepare(
                "SELECT COUNT(*) AS n FROM subtasks WHERE task_id = ? AND done = 0",
              )
              .get(subtask.task_id) as { n: number };
            if (open.n === 0) {
              const beforeVersion = currentResultVersion(parentTask.id);
              const version = ensureResultVersionForReview(
                parentTask.id,
                req.userId,
                resultFromSubtasks(parentTask.id),
              );
              db.prepare(
                "UPDATE tasks SET agent_state = 'review', updated_at = datetime('now') WHERE id = ?",
              ).run(parentTask.id);
              bumpContextVersion(parentTask.id);
              // Последний закрытый шаг автоматически сдаёт родителя в
              // review. Завершаем именно его содержательную попытку здесь,
              // иначе у задачи остаётся живая аренда после сдачи и метрики
              // принимают её за брошенную работу.
              const parentAttempt = db
                .prepare("SELECT current_attempt_id FROM tasks WHERE id = ?")
                .get(parentTask.id) as
                | { current_attempt_id?: string | null }
                | undefined;
              if (parentAttempt?.current_attempt_id) {
                db.prepare(
                  `UPDATE attempts
                      SET ended_at = datetime('now'), outcome = 'review',
                          reason = 'все подзадачи закрыты'
                    WHERE id = ? AND ended_at IS NULL`,
                ).run(parentAttempt.current_attempt_id);
                db.prepare(
                  "UPDATE tasks SET current_attempt_id = NULL WHERE id = ? AND current_attempt_id = ?",
                ).run(parentTask.id, parentAttempt.current_attempt_id);
              }
              if (!beforeVersion) {
                logEvent({
                  taskId: parentTask.id,
                  actorId: req.userId,
                  kind: "result_version_created",
                  field: "result_version",
                  toValue: String(version.version_no),
                });
              }
              // actor_id = NULL: это не отдельное действие исполнителя, а
              // следствие закрытия последнего шага — тот же довод, что у
              // lease_expired и у родителя-зонтика.
              logEvent({
                taskId: parentTask.id,
                actorId: null,
                kind: "state_changed",
                field: "agent_state",
                fromValue: "in_progress",
                toValue: "review",
              });

              // Дочерняя сдана — может, пора исполнять родителя (его свои пункты).
              void import("./dispatch.js")
                .then((m) => m.admitParentAfterChildren(parentTask.id))
                .catch((err) => console.warn("родитель после дочерней:", err));
            }
          }

          // ЗАКРЫТ УЗЕЛ ПЛАНА — ОТКРЫВАЕМ СЛЕДУЮЩИЕ ПО ГРАФУ.
          //
          // Независимо от роллапа родительской задачи выше (тот — про
          // «все подзадачи закрыты», этот — про конкретный узел
          // collaboration plan): подзадача-узел без output_artifact
          // (обычный текстовый result) закрывается таким же
          // `taskflow_subtask_done`, как любой шаг, и это и есть её
          // «артефакт готов» — сдача через `/api/subtasks/:id/artifact`
          // (узлы С контрактом) закрывает done сама и вызывает
          // unlockReadyPlanSubtasks оттуда же, повторного срабатывания
          // здесь для них не будет (done уже был 1).
          if (subtask.collaboration_plan_id) {
            await unlockReadyPlanSubtasks(subtask.collaboration_plan_id, subtask.task_id, req.userId);
          }
        }
      }
      if (title) {
        db.prepare("UPDATE subtasks SET title = ? WHERE id = ?").run(
          title,
          req.params.id,
        );
        if (title !== subtask.title) {
          logEvent({
            taskId: subtask.task_id,
            actorId: req.userId,
            kind: "subtask_renamed",
            field: "subtask",
            fromValue: subtask.title,
            toValue: title,
          });
        }
      }
      // position — то же самое ручное перетаскивание, что уже есть у задач
      // на доске (tasks.ts): сознательно НЕ журналируем — то же обоснование,
      // портянка из «шаг переставлен» на каждый пиксель драга никому не
      // нужна. Broadcast всё равно уходит — по нему обновится список.
      if (position !== undefined) {
        db.prepare("UPDATE subtasks SET position = ? WHERE id = ?").run(
          position,
          req.params.id,
        );
      }

      const fullTask = getFullTask(subtask.task_id);
      broadcastTaskEvent([subtask.task_creator_id, subtask.task_assignee_id], {
        type: "task:updated",
        task: fullTask,
      });
      return withSubtaskState(
        db.prepare("SELECT * FROM subtasks WHERE id = ?").get(req.params.id),
      );
    },
  });

  // ═══════ РАБОТА АГЕНТА НАД ПОДЗАДАЧЕЙ ═══════
  //
  // Зачем: до 15.08.2026 по карточке было видно только «агент взял задачу» и
  // «сдал», а где он внутри — нет. Подзадача умела ровно одно: галочку по
  // факту. Теперь агент отмечает НАЧАЛО работы над конкретной подзадачей, и
  // в ленте видно, где он сейчас.
  //
  // Аренда та же, что у задачи, и по той же причине (см. AGENT-PROTOCOL.md
  // и заметку про ручное продление): «в работе» держится СИГНАЛАМИ, а не
  // выставляется раз и навсегда. Замолчал дольше срока — подзадача больше не
  // показывается работающей. Индикатор, который горит без работы, хуже
  // отсутствующего: ровно от этого весь протокол и защищает.
  app.post<{
    Params: { id: string };
    Body: {
      state?: "in_progress" | "blocked" | "review" | null;
      result?: string;
    };
  }>("/api/subtasks/:id/work", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const subtask = getSubtaskWithTaskForUser(req.params.id, req.userId);
      if (!subtask) return reply.code(404).send({ error: "Not found" });

      // Блокер 3 карточки 8ca87c61 (ревью 11.09.2026): подзадача имеет
      // собственную попытку (subtasks.current_attempt_id), а не наследует
      // attempts задачи. attempt_id у шага — отдельный, и сообщения с
      // чужим/устаревшим attempt_id должны отбиваться по нему.
      const claimedAttempt = readAttemptId(req);
      const mismatch = attemptMismatchReason(
        claimedAttempt,
        (subtask as any).current_attempt_id ?? null,
      );
      if (mismatch) {
        return reply.code(400).send({ error: `attempt_id: ${mismatch}` });
      }

      const { state, result } = req.body || {};
      const known =
        state === undefined ||
        state === null ||
        state === "in_progress" ||
        state === "blocked" ||
        state === "review";
      if (!known) {
        return reply
          .code(400)
          .send({ error: "state: in_progress | blocked | review | null" });
      }

      // Правила самого конвейера — одной функцией в agentState.ts рядом с
      // матрицей переходов задачи: взять шаг можно только под взятой
      // задачей, сдать — только побывав в работе, заблокировать и сдать —
      // только с текстом. Раньше здесь лежала одна из этих проверок
      // россыпью; правила конвейера должны жить в одном месте, иначе
      // разъедутся, как разъезжались копии матрицы переходов.
      const caller = db
        .prepare("SELECT type FROM users WHERE id = ?")
        .get(req.userId) as { type?: string } | undefined;
      const refusal = subtaskWorkRefusal({
        from: subtask.agent_state ?? null,
        to: state,
        isAi: caller?.type === "ai",
        taskAgentState: subtask.task_agent_state ?? null,
        hasResult: Boolean(result || subtask.result),
        resultLength: (result ?? "").length,
      });
      if (refusal) {
        return reply.code(refusal.code).send({ error: refusal.error });
      }

      // Выход из review агенту тоже открыт — вместе с отменой обязательной
      // приёмки (20.08.2026) запирать шаг в этом состоянии стало не от чего:
      // review теперь добровольный способ показать работу, а не воронка, из
      // которой выпустить может только владелец.

      // Чужую подзадачу не перехватываем: пока живой держит аренду, второй
      // исполнитель получает отказ — та же защита, что у задачи, иначе два
      // агента напишут разный итог в одну строку.
      const занята =
        subtask.agent_state === "in_progress" &&
        subtask.agent_id &&
        subtask.agent_id !== req.userId &&
        !isStale(subtask.agent_heartbeat_at);
      if (занята && state === "in_progress") {
        return reply
          .code(409)
          .send({ error: "Над подзадачей уже работает другой исполнитель" });
      }

      if (state !== undefined) {
        if (state === null) {
          db.prepare(
            "UPDATE subtasks SET agent_state = NULL, agent_id = NULL, agent_heartbeat_at = NULL WHERE id = ?",
          ).run(req.params.id);
        } else {
          // Вместе с состоянием запоминаем СЕССИЮ, которая физически ведёт
          // этот шаг. Учётка агента одна на все сессии и на всех агентов,
          // поэтому без этой метки чужая работа выглядит своей — Максим
          // 20.08.2026: «другие сессии к этой задаче отношения не имеют,
          // не должно тебя дёргать».
          db.prepare(
            `UPDATE subtasks
                SET agent_state = ?, agent_id = ?, agent_session_id = ?,
                    agent_heartbeat_at = datetime('now')
              WHERE id = ?`,
          ).run(state, req.userId, sessionOf(req), req.params.id);

          // Блокер 3 карточки 8ca87c61: при взятии подзадачи в работу
          // создаём отдельный attempt (subtask_id) и проставляем
          // subtasks.current_attempt_id. Так шаг имеет свою попытку,
          // отдельную от попытки родительской задачи — инвариант C1
          // (не более одной действующей попытки на subtask_id) enforced
          // partial unique index'ом.
          if (state === 'in_progress' && (subtask as any).agent_state !== 'in_progress') {
            const subAttemptId = crypto.randomUUID();
            db.prepare(
              `INSERT INTO attempts
                 (id, task_id, subtask_id, executor_id, runner, model,
                  started_at, heartbeat_at)
                 VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
            ).run(
              subAttemptId,
              subtask.task_id,
              req.params.id,
              req.userId,
              (req.body && (req.body as any).runner) ?? null,
              (req.body && (req.body as any).model) ?? null,
            );
            db.prepare(
              `UPDATE subtasks SET current_attempt_id = ? WHERE id = ?`,
            ).run(subAttemptId, req.params.id);
          }
          // При выходе из in_progress (release) закрываем свою попытку.
          if (state !== 'in_progress' && (subtask as any).current_attempt_id) {
            db.prepare(
              `UPDATE attempts
                  SET ended_at = datetime('now'), outcome = ?, reason = ?
                WHERE id = ? AND ended_at IS NULL`,
            ).run(state === 'review' ? 'review' : 'released', result ?? null, (subtask as any).current_attempt_id);
            db.prepare(
              `UPDATE subtasks SET current_attempt_id = NULL WHERE id = ?`,
            ).run(req.params.id);
          }
          // Сессию поднимаем и на саму задачу, если та её ещё не знает:
          // работа по шагам идёт без claim, и иначе задача остаётся ничьей.
          db.prepare(
            "UPDATE tasks SET agent_session_id = COALESCE(agent_session_id, ?) WHERE id = ?",
          ).run(sessionOf(req), subtask.task_id);
        }
      } else {
        // Тело без state — это продление аренды. Трогаем ТОЛЬКО отметку
        // времени, как и heartbeat у задачи: сигнал не меняет ничего, кроме
        // «я ещё здесь».
        db.prepare(
          "UPDATE subtasks SET agent_heartbeat_at = datetime('now') WHERE id = ?",
        ).run(req.params.id);
      }

      if (result !== undefined) {
        db.prepare("UPDATE subtasks SET result = ? WHERE id = ?").run(
          result || null,
          req.params.id,
        );
      }

      // В журнал — только смена состояния, не каждый сигнал: иначе лента
      // задачи утонет в служебных отметках раз в полторы минуты.
      // subtask_returned (не subtask_released) — когда null приходит ИЗ
      // review: это не агент сам отпустил шаг, это владелец вернул его на
      // доработку, и в ленте это должно читаться иначе (см. проверку прав
      // выше — сюда доходит только владелец).
      if (state !== undefined && state !== subtask.agent_state) {
        logEvent({
          taskId: subtask.task_id,
          actorId: req.userId,
          kind:
            state === "in_progress"
              ? "subtask_started"
              : state === "blocked"
                ? "subtask_blocked"
                : state === "review"
                  ? "subtask_review"
                  : subtask.agent_state === "review"
                    ? "subtask_returned"
                    : "subtask_released",
          field: "subtask",
          toValue: subtask.title,
        });
      }

      const fullTask = getFullTask(subtask.task_id);
      broadcastTaskEvent([subtask.task_creator_id, subtask.task_assignee_id], {
        type: "task:updated",
        task: fullTask,
      });
      const updated: any = withSubtaskState(
        db.prepare("SELECT * FROM subtasks WHERE id = ?").get(req.params.id),
      );
      // Взял шаг в работу — получи правила, как их писать. Тем же ответом,
      // без отдельного запроса и без надежды, что агент их где-то читал.
      return state === "in_progress"
        ? { ...updated, rules: effectiveRules((db.prepare("SELECT role_key FROM users WHERE id=?").get(req.userId) as any)?.role_key ?? "") }
        : updated;
    },
  });

  app.delete<{ Params: { id: string } }>(
    "/api/subtasks/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const subtask = getSubtaskWithTaskForUser(req.params.id, req.userId);
      if (!subtask) return reply.code(404).send({ error: "Not found" });

      db.prepare("DELETE FROM subtasks WHERE id = ?").run(req.params.id);
      logEvent({
        taskId: subtask.task_id,
        actorId: req.userId,
        kind: "subtask_removed",
        field: "subtask",
        fromValue: subtask.title,
      });
      const fullTask = getFullTask(subtask.task_id);
      broadcastTaskEvent([subtask.task_creator_id, subtask.task_assignee_id], {
        type: "task:updated",
        task: fullTask,
      });
      return { ok: true };
    },
  );

  // ── Comments ── same task-ownership scoping.
  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/comments",
    { preHandler: authPre },
    async (req: any, reply) => {
      const task = getTaskForRead(req.params.taskId, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });
      return db
        .prepare(
          `SELECT c.*, u.name as user_name, u.avatar_color as user_color, u.avatar_url as user_avatar_url, u.initials as user_initials
         FROM comments c LEFT JOIN users u ON c.user_id = u.id
         WHERE c.task_id = ? ORDER BY c.created_at`,
        )
        .all(req.params.taskId);
    },
  );

  app.post<{
    Params: { taskId: string };
    Body: { text: string; attachment_ids?: string[] };
  }>("/api/tasks/:taskId/comments", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const task = getTaskForWrite(req.params.taskId, req.userId) as any;
      if (!task) return reply.code(404).send({ error: "Not found" });

      // Шаг 3 карточки 8ca87c61: проверка attempt_id для комментария
      // агента — комментарий это тоже «сообщение от попытки».
      const claimedAttempt = readAttemptId(req);
      const mismatch = attemptMismatchReason(
        claimedAttempt,
        task.current_attempt_id ?? null,
      );
      if (mismatch) {
        return reply.code(400).send({ error: `attempt_id: ${mismatch}` });
      }

      const attachmentIds: string[] = Array.isArray(req.body?.attachment_ids)
        ? req.body.attachment_ids
        : [];
      // Пустой текст допустим, когда приложены файлы: «вот скриншот» без
      // подписи — нормальный комментарий, требовать к нему слова незачем.
      // А вот пустой комментарий совсем без ничего — по-прежнему 400.
      if (!req.body?.text && attachmentIds.length === 0)
        return reply.code(400).send({ error: "text required" });

      const id = uid();
      db.transaction(() => {
        db.prepare(
          "INSERT INTO comments (id, task_id, user_id, text) VALUES (?,?,?,?)",
        ).run(id, req.params.taskId, req.userId, req.body.text ?? "");
        if (
          String(task.assignee_id ?? "").startsWith("role_") &&
          task.assignee_id !== req.userId
        ) {
          enqueueRoleRunJob({
            taskId: req.params.taskId,
            reason: "commented",
            actorId: req.userId,
            dedupeKey: `comment:${id}`,
          });
        }
      })();

      // Комментарий агента — это признак жизни, а не только текст.
      //
      // Владелец 21.08.2026, глядя на доску во время работы Гермеса: «я вижу,
      // что агент пропал, и никаких телодвижений по нашим правилам здесь не
      // происходит. Он может у тебя где-то что-то выполнять, но когда это не
      // завязано на том, где я могу контролировать, — значит не работает».
      //
      // Он был прав буквально: Гермес работал и писал в карточку, а аренда
      // при этом протухала, потому что продлевал её только отдельный
      // heartbeat. Доска показывала «взяли и молчат» у живого агента.
      // Теперь любое его действие по задаче продлевает аренду само.
      // ⚠️ У задачи нет колонки agent_id — исполнителя держит assignee_id,
      // а взятие в работу отмечено agent_state. Первая же попытка с agent_id
      // уронила маршрут пятисоткой, тест поймал сразу.
      db.prepare(
        `UPDATE tasks
            SET agent_heartbeat_at = datetime('now')
          WHERE id = ? AND assignee_id = ? AND agent_state = 'in_progress'`,
      ).run(req.params.taskId, req.userId);

      // Файлы загружаются заранее и лежат «ничьими» (comment_id = NULL) —
      // здесь они подбираются отправленным комментарием. Берём только свои
      // и только по этой задаче: чужое вложение чужой карточки к своему
      // комментарию не привяжется, даже если знать его идентификатор.
      if (attachmentIds.length) {
        const attach = db.prepare(
          `UPDATE attachments SET comment_id = ?
             WHERE id = ? AND task_id = ? AND user_id = ?
               AND comment_id IS NULL AND kind = 'comment'`,
        );
        for (const attId of attachmentIds) {
          attach.run(id, attId, req.params.taskId, req.userId);
        }
      }

      // Notify the other party (creator or assignee, whichever isn't the commenter)
      const notifyTarget =
        task.assignee_id === req.userId ? task.creator_id : task.assignee_id;
      if (notifyTarget && notifyTarget !== req.userId) {
        const user = db
          .prepare("SELECT name FROM users WHERE id = ?")
          .get(req.userId) as any;
        const notifId = uid();
        db.prepare(
          "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, 'commented', ?, ?, ?)",
        ).run(
          notifId,
          notifyTarget,
          req.params.taskId,
          `${user?.name || "Кто-то"} прокомментировал: ${task.title}`,
          req.userId,
        );
        broadcastToUsers([notifyTarget], {
          type: "notification:new",
          notificationId: notifId,
          taskId: req.params.taskId,
        });
      }

      return db
        .prepare(
          `SELECT c.*, u.name as user_name, u.avatar_color as user_color, u.avatar_url as user_avatar_url, u.initials as user_initials
           FROM comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.id = ?`,
        )
        .get(id);
    },
  });
}
