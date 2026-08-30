// Версионные миграции — поверх, а не вместо `migrate()` в db.ts.
//
// `migrate()` уже идемпотентна (CREATE TABLE IF NOT EXISTS + проверки
// колонок перед ALTER TABLE) и продолжает выполняться на каждом старте как
// раньше — переписывать её ради красоты не стали («не переписывать
// существующее ради красоты», см. память Максима). Здесь — только то, чего
// в ней не было: явный, пронумерованный, отслеживаемый список изменений
// схемы поверх базовой, с таблицей `schema_migrations`, которая фиксирует,
// что применено и когда. Это и есть разница между «набором ALTER TABLE,
// защищённых проверкой колонки» и версионными миграциями — здесь видно
// историю, а не только текущее состояние.
//
// `001_baseline` не содержит кода — это ярлык на всё, что уже делает
// migrate(), зафиксированный как отправная точка. Каждая следующая
// миграция — новый прирост схемы, который раньше пришлось бы дописывать в
// migrate() тем же наращиваемым стилем; теперь это отдельная, поимённая,
// один раз применяемая запись.
import db from "./db.js";

export type Migration = {
  id: string;
  description: string;
  up: () => void;
  /**
   * Выполнить `up()` БЕЗ внешней транзакции раннера.
   *
   * Нужно ровно одному классу миграций — пересборке таблицы по 12-шаговой
   * процедуре SQLite: она требует `PRAGMA foreign_keys = OFF`, а эта
   * прагма внутри открытой транзакции молча не действует. Такая миграция
   * обязана быть идемпотентной и держать транзакцию внутри себя сама:
   * отметка в schema_migrations ставится уже после её выхода, и падение
   * между ними означает повторный прогон на следующем старте.
   */
  noTransaction?: boolean;
};

const migrations: Migration[] = [
  {
    id: "001_baseline",
    description:
      "схема на момент введения versioned migrations — уже применена через migrate() в db.ts, здесь только отметка",
    up: () => {},
  },
  {
    id: "002_indexes",
    description:
      "индексы на внешние ключи, не покрытые PRIMARY KEY — иначе каждый список задач/подзадач/меток был бы полным сканом таблицы",
    up: () => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks(creator_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
        CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id);
        CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
        CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);
        CREATE INDEX IF NOT EXISTS idx_attachments_comment ON attachments(comment_id);
        CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
        CREATE INDEX IF NOT EXISTS idx_labels_owner ON labels(owner_id);
        CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
        CREATE INDEX IF NOT EXISTS idx_task_labels_label ON task_labels(label_id);
      `);
      // task_labels(task_id) не добавляется отдельно — это уже левый
      // столбец её собственного PRIMARY KEY (task_id, label_id), SQLite
      // строит по нему неявный индекс сам.
    },
  },
  {
    id: "003_subtask_work",
    description:
      "подзадача как единица работы: кто её ведёт, когда подал сигнал, и краткий итог — чтобы в ленте было видно, ГДЕ агент внутри задачи, а не только «взял» и «сдал»",
    up: () => {
      // Состояния намеренно те же, что у задачи (agentState.ts): NULL —
      // никто не ведёт, in_progress — ведут сейчас, blocked — упёрлись.
      // Отдельного «done» здесь нет: готовность подзадачи как была, так и
      // осталась в поле done — не заводим второй источник правды о том же.
      db.exec(`
        ALTER TABLE subtasks ADD COLUMN agent_state TEXT;
        ALTER TABLE subtasks ADD COLUMN agent_id TEXT REFERENCES users(id);
        ALTER TABLE subtasks ADD COLUMN agent_heartbeat_at TEXT;
        ALTER TABLE subtasks ADD COLUMN result TEXT;
      `);
      // Индекс под «покажи, что сейчас в работе» — выборка идёт по
      // состоянию, а не по задаче.
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_subtasks_agent_state ON subtasks(agent_state)",
      );
    },
  },
  {
    id: "004_agent_session_id",
    description:
      "чей это claim физически: несколько параллельных сессий Claude Code делят один и тот же учётный аккаунт-агента (Claude_Bot) в TaskFlow, поэтому agent_state/assignee_id одни не отличают «эту сессию ведёт мой процесс» от «ведёт кто-то ещё под тем же ботом» — понадобилось после того, как taskflow-progress-gate.py (Stop-хук) начал блокировать сессии чужой незавершённой работой того же бота (18.08.2026)",
    up: () => {
      db.exec("ALTER TABLE tasks ADD COLUMN agent_session_id TEXT;");
    },
  },
  {
    id: "004b_subtask_session",
    description:
      "какая сессия ведёт КОНКРЕТНЫЙ шаг. У задачи такое поле есть с 004, у шага не было — и работа, идущая по шагам (subtask_work без claim), оставалась без хозяина: любая параллельная сессия под тем же ботом видела её как свою и на неё реагировала. Максим 20.08.2026: «система должна идентифицировать, кто создал и кто работал по этой задаче или подзадаче, и реагировать исключительно на эту сессию — а другие сессии к этой задаче отношения не имеют».",
    up: () => {
      db.exec("ALTER TABLE subtasks ADD COLUMN agent_session_id TEXT;");
    },
  },
  {
    id: "005_task_time_of_day",
    description:
      "час начала и длительность задачи — под календарную развёртку в разделе «День» (18.08.2026). Оба поля НЕОБЯЗАТЕЛЬНЫЕ и по умолчанию пустые: задача без них остаётся обычной задачей списка, поведение существующих 106 задач не меняется. Хранение намеренно симметрично due_date: там голая дата «ГГГГ-ММ-ДД» без времени и часового пояса, здесь — голое местное время «ЧЧ:ММ» тем же текстом, без даты и пояса. Держать время внутри due_date (ISO-таймстамп) было бы дороже: пришлось бы переписать все существующие сравнения дат на фронте и сервере и завести работу с поясами ради поля, которое у 90 задач из 106 пустое.",
    up: () => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN start_time TEXT;
        ALTER TABLE tasks ADD COLUMN duration_min INTEGER;
      `);
      // Выборка календаря — «что на этот день, по порядку часов»: сначала
      // отсекается дата, потом сортируется время. Индекс по паре, а не по
      // одному start_time, иначе он этой выборке не поможет.
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_tasks_due_start ON tasks(due_date, start_time)",
      );
    },
  },
  {
    id: "006_attachment_kind",
    description:
      "вид вложения: 'comment' (файл в ленте, у своего комментария — единственное поведение до 19.08.2026) или 'task' (файл приложен к самой задаче, в её заметке). Понадобилось, чтобы файлы можно было прикладывать ПРИ СОЗДАНИИ задачи, а не только комментарием после (просьба Максима 19.08.2026). Отличить одним comment_id нельзя: у комментарийного вложения он тоже NULL всё время, пока комментарий не отправлен, — брошенный черновик после перезагрузки страницы выглядел бы вложением задачи. Все существующие записи получают 'comment' — это про них правда, других вложений до сих пор не было.",
    up: () => {
      // DEFAULT 'comment' в ALTER TABLE проставляет значение и уже
      // существующим строкам — отдельный UPDATE не нужен.
      db.exec(
        "ALTER TABLE attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment';",
      );
    },
  },
  {
    id: "007_clear_agent_state_on_done_subtasks",
    description:
      "разовая уборка данных, а не схемы: у 114 закрытых шагов оставался agent_state («в работе» у 11, «сдан» у 103) — до 20.08.2026 закрытие шага меняло только колонку done. Чтение это скрывало (фильтр !s.done и вычисленное state='done'), но стоило владельцу снять галочку, как остаток оживал и закрытая работа снова выглядела идущей — именно так Максим поймал баг вечером 20.08.2026. Источник закрыт в routes/subtasks.ts, здесь подчищаются уже накопленные строки, иначе каждая такая галочка остаётся миной. Незакрытых шагов уборка не касается — у них состояние настоящее.",
    up: () => {
      db.exec(`
        UPDATE subtasks
           SET agent_state = NULL, agent_id = NULL, agent_heartbeat_at = NULL
         WHERE done = 1 AND agent_state IS NOT NULL;
      `);
    },
  },
  {
    id: "008_shared_dictionaries_belong_to_owner",
    description:
      "проекты и метки, заведённые агентами, переписываются на владельца. Справочник — общий инструмент: им пользуются владелец и все агенты. Записанный на агента, он для остальных не существует, потому что агент видит только своё и принадлежащее владельцам. Поймано 22.08.2026: проект «AI Control Center» завёл Claude_Bot, и Гермес, получив задание по нему, не увидел проекта в списке вовсе — решил, что задачи нет, и завёл её у себя во внутреннем кабане. Источник закрыт в access.ts (ownerForNewShared), здесь переписываются уже заведённые.",
    up: () => {
      db.exec(`
        UPDATE projects
           SET owner_id = (SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1)
         WHERE owner_id IN (SELECT id FROM users WHERE type = 'ai');

        UPDATE labels
           SET owner_id = (SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1)
         WHERE owner_id IN (SELECT id FROM users WHERE type = 'ai');
      `);
    },
  },
  {
    id: "009_integrations",
    description:
      "таблицы для интеграций с внешними сервисами (Google Tasks, Apple Reminders/Calendar): хранение токенов, настроек и маппинга внешних идентификаторов задач",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_integrations (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          account_email TEXT,
          access_token TEXT,
          refresh_token TEXT,
          token_expires_at INTEGER,
          settings TEXT DEFAULT '{}',
          last_synced_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          UNIQUE(user_id, provider)
        );

        CREATE TABLE IF NOT EXISTS task_external_mappings (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          external_id TEXT NOT NULL,
          external_list_id TEXT,
          last_synced_at TEXT DEFAULT (datetime('now')),
          UNIQUE(task_id, provider)
        );

        CREATE INDEX IF NOT EXISTS idx_task_mappings_task ON task_external_mappings(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_mappings_ext ON task_external_mappings(provider, external_id);
      `);
    },
  },
  {
    id: "010_notes",
    description:
      "единая страница «Заметки» (вход из «Ежедневника», 25.08.2026) — блочный редактор TipTap, контент хранится как одна строка JSON. Одна общая запись (id='main'), а не таблица по пользователю/проекту — владелец попросил именно общее пространство заметок, не отдельное на проект.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL DEFAULT '',
          updated_at TEXT DEFAULT (datetime('now')),
          updated_by TEXT REFERENCES users(id)
        );
      `);
      const existing = db
        .prepare("SELECT id FROM notes WHERE id = 'main'")
        .get();
      if (!existing) {
        db.prepare("INSERT INTO notes (id, content) VALUES ('main', '')").run();
      }
    },
  },
  {
    id: "011_journal_entries",
    description:
      "«Дневник» (25.08.2026) заменяет единую страницу «Заметки» — владелец попросил, чтобы каждый день был своей записью, а не одним общим листом. id = сама дата 'YYYY-MM-DD' (не uuid — дата и так уникальный естественный ключ, отдельный столбец под неё избыточен). Таблица `notes` из 010_notes НЕ трогаем и не дропаем (не переписывать применённые миграции) — она просто больше ничем не используется. Если в старой общей заметке уже что-то написано, переносим этот текст в запись за сегодня одной строкой, чтобы владелец не потерял написанное при переходе на новую модель.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS journal_entries (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL DEFAULT '',
          updated_at TEXT DEFAULT (datetime('now')),
          updated_by TEXT REFERENCES users(id)
        );
      `);
      const oldNote = db
        .prepare("SELECT content FROM notes WHERE id = 'main'")
        .get() as { content?: string } | undefined;
      if (oldNote?.content) {
        const today = new Date().toISOString().slice(0, 10);
        db.prepare(
          "INSERT OR IGNORE INTO journal_entries (id, content) VALUES (?, ?)",
        ).run(today, oldNote.content);
      }
    },
  },

  {
    id: "012_journal_folders",
    description:
      "Древовидные папки для заметок Дневника (26.08.2026, после согласования с владельцем — см. .hermes/plans/journal-folders.md). Заметка лежит ровно в одной папке (folder_id, ON DELETE SET NULL → заметка «выпадает» в корень «Без папки» при удалении папки — это намеренно: удалять заметки по ошибке при чистке папок нельзя). Сортировка папок между братьями — по position, при равенстве — по id. Папки живут в одном общем дереве на аккаунт, как и сами записи (заметки владельца и агентов в одной ленте — тот же дневник).",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS journal_folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parent_id INTEGER REFERENCES journal_folders(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_journal_folders_parent
          ON journal_folders(parent_id, position);
      `);
      // folder_id в journal_entries. SQLite ALTER TABLE ADD COLUMN поддержан;
      // default NULL = заметка без папки (корень «Без папки» в UI).
      // ON DELETE SET NULL — потому что заметка не должна пропадать при чистке
      // папки; владелец прямо сказал «заметки терять нельзя».
      const cols = db
        .prepare("PRAGMA table_info(journal_entries)")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "folder_id")) {
        db.exec(
          `ALTER TABLE journal_entries ADD COLUMN folder_id INTEGER REFERENCES journal_folders(id) ON DELETE SET NULL;`,
        );
      }
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_journal_entries_folder ON journal_entries(folder_id);`,
      );
    },
  },
  {
    id: "013_user_notes",
    description:
      "Заметки становятся самостоятельными (26.08.2026, решение владельца: «обычные заметки: сколько угодно в день, у каждой своё название, дата — просто когда создана»). Прежняя модель journal_entries — «один день = одна запись, id = дата» — не давала ни второй заметки за день, ни собственного имени, из-за чего «создать заметку в папке» означало «переложить сюда сегодняшний день». Новая таблица user_notes (имя notes занято заброшенной таблицей из 010_notes — там одна строка 'main' от единой страницы «Заметки»; применённые миграции не переписываем): uuid, title, content, folder_id, created_at/updated_at. Папки переиспользуются те же (journal_folders из 012). Существующие записи дневника переносятся строками notes с названием по дате — Дневник по дням при этом продолжает жить на journal_entries, это отдельная сущность и трогать её не нужно.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_notes (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '',
          folder_id INTEGER REFERENCES journal_folders(id) ON DELETE SET NULL,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          updated_by TEXT REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_notes_folder ON user_notes(folder_id, updated_at DESC);
      `);
      // Переносим существующие записи дневника, чтобы ничего не пропало
      // из виду: название — дата записи, папка сохраняется. Сам
      // journal_entries НЕ трогаем (не переписывать применённые
      // миграции, плюс Дневник по дням остаётся рабочим экраном).
      const rows = db
        .prepare(
          "SELECT id, content, folder_id, updated_at FROM journal_entries WHERE trim(content) != ''",
        )
        .all() as Array<{
        id: string;
        content: string;
        folder_id: number | null;
        updated_at: string | null;
      }>;
      const insert = db.prepare(
        `INSERT OR IGNORE INTO user_notes (id, title, content, folder_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        insert.run(
          `journal-${r.id}`,
          r.id,
          r.content,
          r.folder_id,
          r.updated_at ?? null,
          r.updated_at ?? null,
        );
      }
    },
  },
  {
    id: "014_project_notes_folder",
    description:
      "Папка заметок у проекта (26.08.2026, выбор владельца из четырёх вариантов связи заметок с задачами: «если есть какой-то проект, я бы мог прям прикрепить папку заметки и туда по этому проекту всю документацию скидывать»). Колонка notes_folder_id в projects указывает на существующую папку в journal_folders — НЕ отдельная иерархия: папка остаётся видна в Дневнике, работает перетаскивание, ничего не дублируется. ON DELETE SET NULL — удалили папку, проект просто теряет привязку, сам не страдает.",
    up: () => {
      const cols = db.prepare("PRAGMA table_info(projects)").all() as Array<{
        name: string;
      }>;
      if (!cols.some((c) => c.name === "notes_folder_id")) {
        db.exec(
          `ALTER TABLE projects ADD COLUMN notes_folder_id INTEGER REFERENCES journal_folders(id) ON DELETE SET NULL;`,
        );
      }
    },
  },
  {
    id: "015_chat",
    description:
      "Чат агентов (27.08.2026, решение владельца): постоянно живущая сессия-резидент читает канал, доступный на запись любой сессии через taskflow_chat_send — координация Клода, Гермеса и остальных исполнителей, Максим читает и участвует. to_user_id NULL = сообщение всем; task_id NULL = висит в общей ленте, никого не будит (правило «ПОВОД, а не счётчик» — будит только сообщение, привязанное к задаче). kind — тип сообщения (совещание/делегирование/находка), нужен сразу для правила закрытия разговора, чтобы не писать 016 тем же днём. chat_reads(user_id, last_read_at) — по одной строке на пользователя, апсертится при каждом прочтении.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id TEXT PRIMARY KEY,
          from_user_id TEXT NOT NULL REFERENCES users(id),
          to_user_id TEXT REFERENCES users(id),
          task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          kind TEXT CHECK (kind IS NULL OR kind IN ('совещание', 'делегирование', 'находка')),
          text TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_chat_messages_to ON chat_messages(to_user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_chat_messages_task ON chat_messages(task_id);

        CREATE TABLE IF NOT EXISTS chat_reads (
          user_id TEXT PRIMARY KEY REFERENCES users(id),
          last_read_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    id: "016_orchestrator_role",
    description:
      "Роль 'orchestrator' (задача af2107b2, 28.08.2026): оркестратор ведёт работу ботов — читает и правит любые проекты и задачи, назначает исполнителей, заводит подзадачи, но ничего не удаляет (запрет в authOrApiToken, auth.ts). Роль хранится в users.role, поэтому расширяется CHECK — в SQLite это только пересборкой таблицы. Заодно роль получает уже заведённая учётка «Оркестратор Claude», ради которой всё и делается.",
    noTransaction: true,
    up: () => {
      const current = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")
        .get() as { sql?: string } | undefined;
      const ddl = current?.sql ?? "";

      // Свежая база уже создана с новым CHECK (db.ts) — пересобирать нечего.
      if (ddl && !ddl.includes("'orchestrator'")) {
        const oldCheck = "CHECK(role IN ('owner','agent','viewer'))";
        const newCheck = "CHECK(role IN ('owner','agent','viewer','orchestrator'))";
        if (!ddl.includes(oldCheck)) {
          throw new Error(
            "016_orchestrator_role: не нашёл ожидаемый CHECK у users, схема разошлась с ожиданием — миграция остановлена, чтобы не пересобрать таблицу вслепую",
          );
        }

        // 12-шаговая процедура SQLite (ALTER TABLE, «Making Other Kinds Of
        // Table Schema Changes»). Порядок именно такой: новая таблица →
        // копия → DROP старой → RENAME. Наоборот (сначала переименовать
        // старую) нельзя: с версии 3.25 SQLite переписывает REFERENCES в
        // дочерних таблицах вслед за переименованием, и все ссылки на
        // users уехали бы на users_old.
        //
        // Новая схема строится ИЗ ЖИВОЙ, заменой одной строки CHECK, а не
        // из определения в db.ts: в базе у users есть колонки, которых там
        // нет (is_system_bot, created_by, avatar_url*), и сборка «по
        // образцу из кода» их бы потеряла.
        const newDdl = ddl
          .replace(oldCheck, newCheck)
          .replace(/CREATE TABLE\s+"?users"?/i, 'CREATE TABLE "users_new"');

        db.pragma("foreign_keys = OFF");
        try {
          const rebuild = db.transaction(() => {
            db.exec(newDdl);
            db.exec('INSERT INTO "users_new" SELECT * FROM users');
            db.exec("DROP TABLE users");
            db.exec('ALTER TABLE "users_new" RENAME TO users');
          });
          rebuild();

          // Считаем ТОЛЬКО ссылки на users: в живой базе 28.08.2026 уже
          // лежат осиротевшие subtasks и task_events от давно удалённых
          // задач (parent='tasks'), к пересборке они отношения не имеют, а
          // проверка «весь foreign_key_check пуст» уронила бы старт сервера
          // на ровном месте.
          const broken = (
            db.pragma("foreign_key_check") as Array<{ parent?: string }>
          ).filter((row) => row.parent === "users");
          if (broken.length > 0) {
            throw new Error(
              `016_orchestrator_role: после пересборки users осталось ${broken.length} битых ссылок на users`,
            );
          }
        } finally {
          db.pragma("foreign_keys = ON");
        }
      }

      // Учётка оркестратора заведена раньше (28.08.2026) обычным агентом —
      // теперь у неё своя роль. На чистой базе строки нет, и это не ошибка:
      // роль существует сама по себе, пользователей ей раздаёт владелец.
      db.prepare(
        "UPDATE users SET role = 'orchestrator' WHERE email = ? AND role <> 'owner'",
      ).run("оркестратор-claude@taskflow.local");
    },
  },
  {
    id: "017_chat_attachments",
    description:
      "Файлы в сообщениях чата (28.08.2026, владелец: «нужно в окне ввода также добавить возможность прикреплять какие-то файлы»). Отдельной таблицы не заводим: у attachments уже есть всё нужное — байты на диске, mime, размер, автор — и task_id там с самого начала NULL-евый, так что вложение вне задачи схема допускает. Добавляется одна колонка chat_message_id: NULL, пока файл залит, но сообщение ещё не отправлено (тот же приём «ничьего вложения», что у комментариев), и проставляется, когда сообщение уходит.",
    up: () => {
      db.exec(`
        ALTER TABLE attachments ADD COLUMN chat_message_id TEXT
          REFERENCES chat_messages(id) ON DELETE CASCADE;
        CREATE INDEX IF NOT EXISTS idx_attachments_chat
          ON attachments(chat_message_id);
      `);
    },
  },
  {
    id: "018_chat_channels",
    description:
      "Два канала чата (28.08.2026, владелец: «должно быть тут 2 канала: у нас с тобой, оркестратор, и другой канал между вами, чтобы я только для контроля туда смотрел»). Канал — свойство САМОГО сообщения, а не отдельная таблица: разделяются потоки одной ленты, а не заводится второй чат со своими вложениями, прочтениями и «печатает…». channel='owner' — разговор владельца с оркестратором, channel='agents' — рабочая переписка исполнителей. Значение выводит сервер из ролей отправителя и адресата (routes/chat.ts), клиент его не присылает. Старую переписку раскладываем по тому же правилу: владелец↔оркестратор в обе стороны — в его канал, всё остальное (включая прежние броадкасты владельца «всем») — в служебный.",
    up: () => {
      db.exec(`
        ALTER TABLE chat_messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'agents'
          CHECK (channel IN ('owner', 'agents'));
        CREATE INDEX IF NOT EXISTS idx_chat_messages_channel
          ON chat_messages(channel, created_at);
      `);

      // Роли, а не зашитые id: учётка оркестратора уже однажды переезжала
      // (см. chat_resident_watch.py), роль переезд переживает. Нет одной из
      // них — раскладывать нечего, вся история остаётся служебной.
      const roleId = (role: string) =>
        (
          db
            .prepare(
              "SELECT id FROM users WHERE role = ? ORDER BY created_at LIMIT 1",
            )
            .get(role) as { id: string } | undefined
        )?.id ?? null;
      const owner = roleId("owner");
      const orchestrator = roleId("orchestrator");
      if (owner && orchestrator) {
        db.prepare(
          `UPDATE chat_messages SET channel = 'owner'
             WHERE (from_user_id = ? AND to_user_id = ?)
                OR (from_user_id = ? AND to_user_id = ?)`,
        ).run(owner, orchestrator, orchestrator, owner);
      }
    },
  },
  {
    id: "019_user_integrations_limits",
    description:
      "Остаток лимитов исполнителя (29.08.2026, владелец: «нужно, чтобы каждый агент начал видеть остаток своих лимитов», а оркестратор — все, и раздавал работу с оглядкой на них). Колонка хранит ответ провайдера как есть, JSON-строкой: у разных провайдеров разные единицы (запросы, токены, окно сброса), и приводить их к одному виду на уровне базы значило бы терять подробности. Заводится ОТДЕЛЬНОЙ миграцией, а не правкой 013: та таблица давно создана на живой базе, и дописанная в её CREATE TABLE колонка не появляется — 29.08.2026 на этом /api/agents отвечал 500 «no such column: limits», а владелец из-за этого не мог сменить исполнителя у задачи.",
    up: () => {
      const cols = db
        .prepare("PRAGMA table_info(user_integrations)")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "limits")) {
        db.exec("ALTER TABLE user_integrations ADD COLUMN limits TEXT DEFAULT '{}'");
      }
    },
  },
];

/** Применить все ещё не применённые миграции, по одной транзакции на каждую. */
export function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    (
      db.prepare("SELECT id FROM schema_migrations").all() as Array<{
        id: string;
      }>
    ).map((r) => r.id),
  );

  const record = (m: Migration) =>
    db
      .prepare("INSERT INTO schema_migrations (id, description) VALUES (?, ?)")
      .run(m.id, m.description);

  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    if (m.noTransaction) {
      // Транзакцию такая миграция держит внутри себя — см. Migration.noTransaction.
      m.up();
      record(m);
      continue;
    }
    const txn = db.transaction(() => {
      m.up();
      record(m);
    });
    txn();
  }
}
