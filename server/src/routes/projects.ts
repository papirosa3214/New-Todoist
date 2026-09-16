import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db, { hashApiToken } from "../db.js";
import { authOrApiToken } from "../auth.js";
import { snapshotFor } from "../activeAgent.js";
import {
  getProjectForUser,
  getProjectForWrite,
  getLabelForUser,
  visibleScope,
  ownerForNewShared,
} from "../access.js";

const uid = () => crypto.randomUUID();

export function registerProjectLabelRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // ── Projects ──
  app.get("/api/projects", { preHandler: authPre }, async (req: any) => {
    // Считаются только АКТИВНЫЕ задачи. Раньше считались все, вместе с
    // выполненными, и число рядом с проектом расходилось с тем, что
    // человек видит, провалившись внутрь: «Входящие — 10», а в списке
    // три (7 из них давно закрыты). Найдено Максимом 14.08.2026.
    // Экран проекта (ProjectTasksScreen) показывает именно активные —
    // счётчик обязан отвечать на тот же вопрос, что и экран под ним.
    //
    // Остальные числа добавлены 08.09.2026 под карточку проекта в нативном
    // клиенте: там проект показывается не строкой, а карточкой с прогрессом
    // («12 из 30»), просрочкой и датой последнего движения. Считать это на
    // клиенте нельзя — пришлось бы тянуть задачи каждого проекта отдельным
    // запросом. Одна группировка по tasks отдаёт всё сразу.
    //
    // `last_activity_at` — MAX(updated_at) по задачам, а не created_at
    // проекта: вопрос владельца звучит как «сколько он уже висит без
    // движения», а не «когда его завели».
    const taskAggregates = `
      LEFT JOIN (
        SELECT project_id,
               SUM(status = 'active')                      AS active_count,
               SUM(status = 'completed')                   AS completed_count,
               SUM(status = 'active'
                   AND due_date IS NOT NULL
                   AND due_date < date('now', 'localtime')) AS overdue_count,
               MAX(updated_at)                             AS last_activity_at
        FROM tasks
        WHERE project_id IS NOT NULL
        GROUP BY project_id
      ) t ON t.project_id = p.id`;

    // Документы проекта — записи в его папке заметок (`notes_folder_id`,
    // заводится флагом with_docs при создании). Для карточки нужно только
    // их число: «есть ли у проекта база знаний и насколько она набита».
    //
    // Считается по `user_notes` — это и есть документация: туда пишут
    // `/api/notes` и MCP-инструменты агентов (`taskflow_doc_write`). Первая
    // версия этого агрегата (08.09.2026) считала `journal_entries` и давала
    // ноль всем проектам: в той таблице лежит одна старая дневниковая запись,
    // а 57 реальных документов — в `user_notes`.
    const docsAggregate = `
      LEFT JOIN (
        SELECT folder_id, COUNT(*) AS docs_count
        FROM user_notes
        WHERE folder_id IS NOT NULL
        GROUP BY folder_id
      ) d ON d.folder_id = p.notes_folder_id`;

    // Кому какие проекты видны — общее правило из access.ts (visibleScope):
    // владельцу все, агенту свои и людские, прочему человеку только свои.
    //
    // Решение Максима 14.08.2026: «это его личный трекер, один человек и его
    // же агенты — стена между ними смысла не имеет». Раньше агенту отдавался
    // пустой список, хотя положить задачу в проект человека он был вправе, —
    // приходилось угадывать идентификатор проекта.
    const scope = visibleScope(req.userId, "p.owner_id");
    // pinned сначала, дальше по position (NULL — «никогда не переставляли»
    // — уезжает в конец через SQLite'вский ASC NULLS LAST-эквивалент: сырой
    // ASC кладёт NULL первым, поэтому сортируем по «p.position IS NULL»
    // как первому ключу), внутри одной группы — created_at, чтобы порядок
    // был детерминирован и до первого ручного перетаскивания (20.08.2026,
    // тот же паттерн, что и сортировка задач внутри проекта ниже).
    const rows = db
      .prepare(
        `SELECT p.*,
                COALESCE(t.active_count, 0)    AS task_count,
                COALESCE(t.completed_count, 0) AS completed_count,
                COALESCE(t.overdue_count, 0)   AS overdue_count,
                t.last_activity_at             AS last_activity_at,
                COALESCE(d.docs_count, 0)      AS docs_count
         FROM projects p ${taskAggregates} ${docsAggregate}
         WHERE ${scope.sql}
         ORDER BY p.pinned DESC, p.position IS NULL, p.position ASC, p.created_at ASC`,
      )
      .all(...scope.params) as any[];

    // Кто из агентов сейчас занят в проекте. Отдельным запросом, а не пятым
    // подзапросом в основном: строк здесь ровно столько, сколько живых пар
    // «агент × проект» (единицы), и сшить их в JS дешевле, чем гонять
    // group_concat и потом разбирать строку.
    const agentRows = db
      .prepare(
        `SELECT t.project_id AS projectId, u.id AS id, u.name AS name,
                COUNT(*) AS tasks
           FROM tasks t
           JOIN users u ON u.id = t.assignee_id AND u.type = 'ai'
          WHERE t.status = 'active' AND t.project_id IS NOT NULL
          GROUP BY t.project_id, u.id
          ORDER BY tasks DESC, u.name`,
      )
      .all() as Array<{ projectId: string; id: string; name: string; tasks: number }>;

    const agentsByProject = new Map<string, Array<{ id: string; name: string; tasks: number }>>();
    for (const r of agentRows) {
      const list = agentsByProject.get(r.projectId) ?? [];
      list.push({ id: r.id, name: r.name, tasks: r.tasks });
      agentsByProject.set(r.projectId, list);
    }

    return rows.map((p) => ({ ...p, agents: agentsByProject.get(p.id) ?? [] }));
  });

  app.post<{
    Body: {
      name: string;
      color?: string;
      with_docs?: boolean;
      /** Датасет базы знаний под этот проект. Пусто — общий датасет
       *  TaskFlow: так вело себя всё до 08.09.2026, когда владелец
       *  попросил разделять («мало ли специфический бизнесовый проект —
       *  не хотелось бы замешивать документацию не туда»). */
      knowledge_dataset_id?: string | null;
    };
  }>(
    "/api/projects",
    {
      preHandler: authPre,
      handler: async (req: any, reply) => {
        const name =
          typeof req.body?.name === "string" ? req.body.name.trim() : "";
        if (!name) {
          return reply.code(400).send({ error: "Укажите название проекта" });
        }
        const id = uid();
        const { color } = req.body;
        const datasetId =
          typeof req.body?.knowledge_dataset_id === "string" &&
          req.body.knowledge_dataset_id.trim()
            ? req.body.knowledge_dataset_id.trim()
            : null;
        db.prepare(
          "INSERT INTO projects (id, name, color, owner_id, knowledge_dataset_id) VALUES (?,?,?,?,?)",
          // Проект — общий инструмент: агент заводит его для работы, а не
          // для себя. Записанный на агента, он не виден остальным (см.
          // ownerForNewShared).
        ).run(id, name, color || "#4A9FD8", ownerForNewShared(req.userId), datasetId);

        // Папка документации — по запросу (26.08.2026, для агентов).
        // Не по умолчанию: человек заводит проекты из интерфейса и пустая
        // папка на каждый из них засорила бы дерево заметок. Агент же
        // просит явно и сразу складывает туда документацию.
        if (req.body?.with_docs === true) {
          const pos = db
            .prepare(
              "SELECT COALESCE(MAX(position), 0) + 1 AS p FROM journal_folders WHERE parent_id IS NULL",
            )
            .get() as { p: number };
          const res = db
            .prepare(
              "INSERT INTO journal_folders (parent_id, name, position) VALUES (NULL, ?, ?)",
            )
            .run(name, pos.p);
          db.prepare(
            "UPDATE projects SET notes_folder_id = ? WHERE id = ?",
          ).run(res.lastInsertRowid, id);
        }
        return db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
      },
    },
  );

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      color?: string;
      position?: number | null;
      pinned?: boolean;
      /** Папка заметок проекта; null — отвязать. */
      notes_folder_id?: number | null;
      /** Датасет базы знаний; null — вернуть проект в общий. */
      knowledge_dataset_id?: string | null;
      /** Согласие на переиндексацию при смене датасета (см. 409 ниже). */
      confirm_reindex?: boolean;
    };
  }>("/api/projects/:id", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      // Правка — write-путь: он же пускает оркестратора в чужой проект
      // (access.ts). Удаление ниже осталось на getProjectForUser.
      let project = getProjectForWrite(req.params.id, req.userId);

      // Особый случай: агент прикрепляет папку документации к проекту
      // человека (26.08.2026). Обычный PATCH пускает только владельца — и
      // правильно делает, чужие проекты агент переименовывать не должен.
      // Но привязка папки заметок — не редактирование проекта, а ровно то,
      // ради чего документация и заводилась: агент кладёт в неё описания,
      // разборы, ТЗ. Разрешаем узко: ТОЛЬКО когда в теле нет ничего, кроме
      // notes_folder_id.
      if (!project) {
        const keys = Object.keys(req.body || {});
        const onlyFolder = keys.length === 1 && keys[0] === "notes_folder_id";
        const isAgent =
          (
            db
              .prepare("SELECT type FROM users WHERE id = ?")
              .get(req.userId) as { type?: string } | undefined
          )?.type === "ai";
        if (onlyFolder && isAgent) {
          project = db
            .prepare("SELECT * FROM projects WHERE id = ?")
            .get(req.params.id);
        }
      }
      if (!project) return reply.code(404).send({ error: "Not found" });

      // Частичное обновление (20.08.2026, drag&drop/закрепление проектов):
      // раньше name было обязательным всегда, потому что PATCH умел только
      // «переименовать/перекрасить» из формы редактирования — запрос вида
      // {position: 3} падал бы в 400 «Укажите название». Теперь name
      // трогаем, только если он реально пришёл в теле; position/pinned
      // обновляются независимо от него, тем же способом, что и
      // tasks.position (PATCH /api/tasks/:id, routes/tasks.ts).
      const { position, pinned } = req.body || {};
      if (
        position !== undefined &&
        position !== null &&
        !Number.isInteger(position)
      ) {
        return reply.code(400).send({ error: "position must be an integer" });
      }

      const fields: string[] = [];
      const values: unknown[] = [];
      if (req.body?.name !== undefined) {
        const name =
          typeof req.body.name === "string" ? req.body.name.trim() : "";
        if (!name) {
          return reply.code(400).send({ error: "Укажите название проекта" });
        }
        fields.push("name = ?");
        values.push(name);
      }
      if (req.body?.color !== undefined) {
        fields.push("color = ?");
        values.push(req.body.color);
      }
      if (position !== undefined) {
        fields.push("position = ?");
        values.push(position);
      }
      if (pinned !== undefined) {
        fields.push("pinned = ?");
        values.push(pinned ? 1 : 0);
      }
      // Датасет базы знаний. Существование датасета здесь НЕ проверяется: он
      // живёт в RAGFlow, за пределами этой базы, и синхронный поход туда на
      // каждом сохранении проекта — лишняя связность и лишний отказ.
      // Пустая строка приравнена к null: «вернуть проект в общий датасет».
      if (req.body?.knowledge_dataset_id !== undefined) {
        const raw = req.body.knowledge_dataset_id;
        const value =
          typeof raw === "string" && raw.trim() ? raw.trim() : null;
        const current = (project as any).knowledge_dataset_id ?? null;

        if (value !== current) {
          // Сколько документов поедет заново. Считается по папке проекта —
          // ровно то, что синк складывает в датасет.
          const docs = (
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM user_notes WHERE folder_id IS NOT NULL AND folder_id = ?",
              )
              .get((project as any).notes_folder_id ?? -1) as { n: number }
          ).n;

          // Смена датасета у проекта с документами — операция долгая и
          // односторонняя (старые копии удаляются, новые считаются заново),
          // поэтому требует явного confirm_reindex. Пустой проект переносить
          // нечего: подтверждать нечего, пропускаем.
          if (docs > 0 && req.body?.confirm_reindex !== true) {
            // ~20 секунд на документ — наблюдаемая скорость bge-m3 на
            // процессоре этой машины (56 документов индексировались около
            // 18 минут, 08.09.2026). Оценка грубая и намеренно не занижена.
            const minutes = Math.max(1, Math.round((docs * 20) / 60));
            // Текст — в `error`: клиенты (в том числе iOS, см. APIError)
            // читают из тела ошибки именно его, и предупреждение без чисел
            // теряет весь смысл. Поля рядом — для тех, кому нужен разбор.
            return reply.code(409).send({
              error:
                `Смена датасета вызовет переиндексацию: ${docs} док. уедут ` +
                `в другой датасет и будут посчитаны заново, примерно ` +
                `${minutes} мин. Пока идёт индексация, эти документы в поиске ` +
                `не находятся. Подтвердите, чтобы продолжить.`,
              documents: docs,
              estimate_minutes: minutes,
              needs_confirmation: true,
            });
          }
        }

        fields.push("knowledge_dataset_id = ?");
        values.push(value);
      }
      // Папка заметок проекта. Ссылается на существующую папку Дневника
      // (journal_folders), своей иерархии у проекта нет — так папка
      // остаётся видна в Дневнике и работает перетаскивание.
      if (req.body?.notes_folder_id !== undefined) {
        const raw = req.body.notes_folder_id;
        if (raw !== null) {
          if (!Number.isInteger(raw)) {
            return reply.code(400).send({ error: "Неверный notes_folder_id" });
          }
          const exists = db
            .prepare("SELECT id FROM journal_folders WHERE id = ?")
            .get(raw) as { id: number } | undefined;
          if (!exists) {
            return reply.code(400).send({ error: "Папка не найдена" });
          }
        }
        fields.push("notes_folder_id = ?");
        values.push(raw);
      }

      if (fields.length) {
        values.push(req.params.id);
        db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(
          ...values,
        );
      }
      return db
        .prepare("SELECT * FROM projects WHERE id = ?")
        .get(req.params.id);
    },
  });

  app.delete<{ Params: { id: string } }>(
    "/api/projects/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const project = getProjectForUser(req.params.id, req.userId);
      if (!project) return reply.code(404).send({ error: "Not found" });

      db.prepare("UPDATE tasks SET project_id = NULL WHERE project_id = ?").run(
        req.params.id,
      );
      db.prepare("DELETE FROM projects WHERE id = ?").run(req.params.id);
      return { ok: true };
    },
  );

  // ── Labels ──
  app.get("/api/labels", { preHandler: authPre }, async (req: any) => {
    // Та же видимость, что и у проектов (visibleScope в access.ts): метки
    // ставит владелец, а агент лишь пользуется его метками.
    const scope = visibleScope(req.userId, "owner_id");
    return db
      .prepare(`SELECT * FROM labels WHERE ${scope.sql}`)
      .all(...scope.params);
  });

  app.post<{ Body: { name: string; color?: string } }>("/api/labels", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const name =
        typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!name) {
        return reply.code(400).send({ error: "Укажите название метки" });
      }
      const id = uid();
      const { color } = req.body;
      db.prepare(
        "INSERT INTO labels (id, name, color, owner_id) VALUES (?,?,?,?)",
        // То же и с метками: их вешают на чужие задачи, значит видеть их
        // должны все — и владелец, и агенты.
      ).run(id, name, color || "#FF7A8A", ownerForNewShared(req.userId));
      return db.prepare("SELECT * FROM labels WHERE id = ?").get(id);
    },
  });

  app.patch<{
    Params: { id: string };
    Body: { name?: string; color?: string };
  }>("/api/labels/:id", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const label = getLabelForUser(req.params.id, req.userId);
      if (!label) return reply.code(404).send({ error: "Not found" });

      const name =
        typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!name) {
        return reply.code(400).send({ error: "Укажите название метки" });
      }
      const color = req.body?.color || label.color;
      db.prepare("UPDATE labels SET name = ?, color = ? WHERE id = ?").run(
        name,
        color,
        req.params.id,
      );
      return db.prepare("SELECT * FROM labels WHERE id = ?").get(req.params.id);
    },
  });

  app.delete<{ Params: { id: string } }>(
    "/api/labels/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const label = getLabelForUser(req.params.id, req.userId);
      if (!label) return reply.code(404).send({ error: "Not found" });

      db.prepare("DELETE FROM task_labels WHERE label_id = ?").run(
        req.params.id,
      );
      db.prepare("DELETE FROM labels WHERE id = ?").run(req.params.id);
      return { ok: true };
    },
  );

  // ── Agents (users) ── directory used for the assignee picker. Scoped to
  // the caller's own account, the seeded system bots (is_system_bot = 1 —
  // set only by seed/migration, never reachable via /api/auth/register, so
  // an open registration can't self-mint a fake "system bot"), plus anyone
  // they already share a task with (as creator or assignee) — not the whole
  // user table, so an arbitrary freshly-registered account can't enumerate
  // every human on the system. System bots are visible to everyone because
  // assigning a task to one is how a new user forms their first connection.
  // Email is intentionally never selected: the frontend doesn't use it
  // (see src/screens/AgentsScreen.tsx, src/screens/TaskFormScreen.tsx).
  app.get("/api/agents", { preHandler: authPre }, async (req: any) => {
    const rows = db
      .prepare(
        `SELECT id, name, role, type, avatar_color, avatar_url,
                avatar_url_working, avatar_url_blocked, initials, status,
                last_seen_at,
                -- «Живая» аватарка (27.08.2026): что сейчас держит агент как
                -- исполнитель (assignee_id) — blocked приоритетнее working,
                -- застрять важнее показать, чем «просто работает». NULL —
                -- простаивает, рендерится дефолтная avatar_url.
                (CASE
                   WHEN EXISTS (
                     SELECT 1 FROM tasks t
                      WHERE t.assignee_id = users.id AND t.agent_state = 'blocked'
                   ) THEN 'blocked'
                   WHEN EXISTS (
                     SELECT 1 FROM tasks t
                      WHERE t.assignee_id = users.id AND t.agent_state = 'in_progress'
                   ) THEN 'working'
                   ELSE NULL
                 END) AS activity
         FROM users
         WHERE (archived = 0 OR archived IS NULL)
           AND (is_system_bot = 1
            OR id = ?
            OR created_by = ?
            OR id IN (
              SELECT assignee_id FROM tasks WHERE creator_id = ? AND assignee_id IS NOT NULL
              UNION
              SELECT creator_id FROM tasks WHERE assignee_id = ? AND creator_id IS NOT NULL
            ))`,
      )
      .all(req.userId, req.userId, req.userId, req.userId) as Array<{
        id: string;
        last_seen_at: string | null;
      }>;

    // Отпечаток активности (29.08.2026, задача 31f2759e): в памяти
    // лежит «когда агент последний раз стучался и что делал». SQL берёт
    // last_seen_at как страховку (если процесс рестартовался, in-memory
    // снимок пуст), а online/last_action приходят из живого модуля.
    // Для людей модуль возвращает null — у них и так online не нужен.
    return rows.map((row) => {
      const snap = snapshotFor(row.id);
      return {
        ...row,
        online: snap?.online ?? false,
        last_action: snap?.lastAction ?? null,
        last_action_title: snap?.lastActionTitle ?? null,
      };
    });
  });

  // ── Завести агента ── кнопка «Пригласить агента» на экране агентов.
  // Приглашения по почте на этой машине быть не может (SMTP не настроен), да
  // и агент — не человек с ящиком: «пригласить» здесь значит завести учётку
  // и выдать ключ доступа. Ключ показывается РОВНО ОДИН раз, в ответе на это
  // создание: в базе он лежит как есть, но наружу больше не отдаётся ни
  // одним маршрутом (/api/agents и /api/auth/me его вырезают).
  //
  // Кто может: только человек. Агенту незачем плодить себе подобных, а
  // украденный ключ агента иначе стал бы способом наделать учёток.
  app.post<{ Body: { name?: string } }>(
    "/api/agents",
    { preHandler: authPre },
    async (req: any, reply) => {
      const caller = db
        .prepare("SELECT type FROM users WHERE id = ?")
        .get(req.userId) as { type?: string } | undefined;
      if (caller?.type === "ai") {
        return reply
          .code(403)
          .send({ error: "агент не может заводить других агентов" });
      }

      const name = (req.body?.name ?? "").trim();
      if (!name) return reply.code(400).send({ error: "нужно имя агента" });

      // Почта у агента техническая и наружу не показывается (см. /api/agents),
      // но колонка обязательна и уникальна — собираем из имени, а при
      // совпадении отвечаем понятной ошибкой, а не «UNIQUE constraint failed».
      const slug =
        name
          .toLowerCase()
          .replace(/[^a-zа-я0-9]+/gi, "-")
          .replace(/^-|-$/g, "") || "agent";
      const email = `${slug}@taskflow.local`;
      const exists = db
        .prepare("SELECT id FROM users WHERE email = ?")
        .get(email);
      if (exists) {
        return reply
          .code(409)
          .send({ error: "агент с таким именем уже заведён" });
      }

      const id = uid();
      const apiToken = "tf_" + crypto.randomBytes(32).toString("hex");
      // Вход по паролю агенту не нужен — он ходит по ключу. Но колонка
      // обязательна, поэтому кладём заведомо непригодный хеш: подобрать к
      // нему пароль нельзя, а значит учётка не имеет второго входа.
      const unusablePassword = "!" + crypto.randomBytes(24).toString("hex");
      const initials = name.trim().charAt(0).toUpperCase();
      db.prepare(
        `INSERT INTO users (id, name, email, password_hash, role, type, avatar_color, avatar_url, initials, status, api_token, is_system_bot, created_by)
         VALUES (?, ?, ?, ?, 'agent', 'ai', '#A78BFA', NULL, ?, 'offline', ?, 0, ?)`,
        // В базу кладём ОТПЕЧАТОК ключа. Сам ключ уходит в ответе ниже и
        // больше нигде не хранится: показать его повторно невозможно, только
        // выпустить новый. Так утечка файла базы не даёт доступа агента.
      ).run(
        id,
        name,
        email,
        unusablePassword,
        initials,
        hashApiToken(apiToken),
        req.userId,
      );

      const agent = db
        .prepare(
          "SELECT id, name, role, type, avatar_color, avatar_url, initials, status FROM users WHERE id = ?",
        )
        .get(id);
      return reply.code(201).send({ agent, api_token: apiToken });
    },
  );

  // ── Переименовать агента ── карандаш на строке агента (экран «Команда»,
  // 27.08.2026). Только владелец — по роли, не по canManageAvatar: та
  // функция про «чей это агент», а тут прямое «человек управляет ботами».
  app.patch<{ Params: { id: string }; Body: { name?: string } }>(
    "/api/agents/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const caller = db
        .prepare("SELECT role FROM users WHERE id = ?")
        .get(req.userId) as { role?: string } | undefined;
      if (caller?.role !== "owner") {
        return reply
          .code(403)
          .send({ error: "переименовывать агентов может только владелец" });
      }
      const target = db
        .prepare("SELECT id, type FROM users WHERE id = ?")
        .get(req.params.id) as { id?: string; type?: string } | undefined;
      if (!target || target.type !== "ai") {
        return reply.code(404).send({ error: "Not found" });
      }
      const name = (req.body?.name ?? "").trim();
      if (!name) return reply.code(400).send({ error: "нужно имя" });
      const initials = name.charAt(0).toUpperCase();
      db.prepare("UPDATE users SET name = ?, initials = ? WHERE id = ?").run(
        name,
        initials,
        req.params.id,
      );
      const agent = db
        .prepare(
          "SELECT id, name, role, type, avatar_color, avatar_url, initials, status FROM users WHERE id = ?",
        )
        .get(req.params.id);
      return { agent };
    },
  );

  // ── Удалить агента ── корзина на строке агента, только владелец.
  // is_system_bot=1 (Claude_Bot/Hermes/DeepSeek-Agent) блокируем жёстко:
  // их id зашиты в server/scripts/trigger.py (EXTERNAL_AGENTS) и в базовых
  // правах доступа — удаление строки не снимет их из конфига службы,
  // конвейер тихо сломается на эту учётку при следующем пробуждении.
  //
  // Если у агента есть задачи/комментарии/шаги — foreign_keys=ON (db.ts) и
  // не даёт удалить строку (ON DELETE NO ACTION у всех ссылок на users),
  // так и остаётся: молча каскадом стереть чужую историю опаснее, чем
  // отказать понятным сообщением.
  app.delete<{ Params: { id: string } }>(
    "/api/agents/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const caller = db
        .prepare("SELECT role FROM users WHERE id = ?")
        .get(req.userId) as { role?: string } | undefined;
      if (caller?.role !== "owner") {
        return reply
          .code(403)
          .send({ error: "удалять агентов может только владелец" });
      }
      const target = db
        .prepare("SELECT id, type, is_system_bot FROM users WHERE id = ?")
        .get(req.params.id) as
        { id?: string; type?: string; is_system_bot?: number } | undefined;
      if (!target || target.type !== "ai") {
        return reply.code(404).send({ error: "Not found" });
      }
      if (target.is_system_bot) {
        return reply.code(403).send({
          error: "это системный агент, вшитый в конвейер — удалить его нельзя",
        });
      }
      try {
        db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
      } catch (err: any) {
        if (err?.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
          return reply.code(409).send({
            error:
              "у агента есть задачи, шаги или комментарии — сначала переназначь или удали их",
          });
        }
        throw err;
      }
      return { ok: true };
    },
  );
}
