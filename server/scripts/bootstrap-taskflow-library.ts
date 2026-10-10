/** Запускать из server/: npx tsx scripts/bootstrap-taskflow-library.ts [--dry-run] [--name "TaskFlow Library"]
 *
 * Создаёт корневую папку «TaskFlow Library» в `journal_folders` (помечается
 * флагом `is_kb_root=1` миграции `119_kb_root_folder`) и четыре подпапки
 * со служебными индексными документами: Roles, Workflows, Norms, Knowledge
 * Base. Идемпотентен: повторный запуск не дублирует папки и заметки.
 *
 * Назначение — общий «дом знаний» для ролей TaskFlow: они читают отсюда
 * контекст через taskflow_kb_search в первую очередь и сами пополняют
 * (см. plan `docs/plans/abstract-strolling-dolphin.md`).
 *
 * --dry-run: только показать, что будет сделано, ничего не записывать.
 * --name: переопределить имя корневой папки (по умолчанию «TaskFlow Library»).
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { markdownToTiptap } from "../src/lib/markdownToTiptap.js";

const args = process.argv.slice(2);
let dryRun = false;
let rootName = "TaskFlow Library";
for (const arg of args) {
  if (arg === "--dry-run") dryRun = true;
  else if (arg === "--name" && args[args.indexOf(arg) + 1] && !args[args.indexOf(arg) + 1].startsWith("--")) {
    rootName = args[args.indexOf(arg) + 1];
  } else throw new Error(`Неизвестный аргумент: ${arg}`);
}

const SUBFOLDERS: Array<{ name: string; description: string; indexBody: string }> = [
  {
    name: "Roles",
    description: "Метаинформация о ролях TaskFlow: кто что умеет, знает, делает. Не путать с системными промтами — они в server/scripts/role-prompts/<key>.md и roles.prompt в БД.",
    indexBody: `# Roles

Метаинформация о ролях TaskFlow: кто что умеет, знает, делает.

Эта папка НЕ предназначена для системных промтов и AGENTS.md ролей. Те хранятся в:

- server/scripts/role-prompts/<key>.md (fallback);
- roles.prompt в БД (приоритет, правится через /api/runtime/context);
- ~/taskflow/roles/<key>/AGENTS.md (постоянные навыки и скрипты роли).

Здесь — только **кто что умеет и знает**: какие компетенции у каждой роли, с чем она справляется, какие инструменты использует чаще всего. Дополняй при обнаружении новой компетенции; чисти, если роль изменилась.

## Роли

- builder — реализация правок в коде проекта;
- qa — проверка сценариев;
- architect — выбор подхода и архитектурных решений;
- designer — дизайн интерфейсов;
- critic_verifier — итоговая проверка результата;
- analyst — разбор данных;
- researcher — внешний ресёрс (сеть, репозитории);
- secretary — приём голоса/диктовки владельца, превращение в задачи.`,
  },
  {
    name: "Workflows",
    description: "Регламенты работы TaskFlow: протоколы, паттерны передачи, матрицы прав, операционные правила.",
    indexBody: `# Workflows

Регламенты работы TaskFlow: протоколы, паттерны передачи, матрицы прав, операционные правила.

Канонические регламенты — в docs/current/taskflow-flow.md и AGENT-PROTOCOL.md. Сюда складываются **выжимки и шпаргалки**: что роль должна делать на конкретном этапе, какие есть частые сценарии, какие правила идут вразрез с каноном (с пометкой даты и причины).`,
  },
  {
    name: "Norms",
    description: "Внутренние нормативные документы TaskFlow: правила выполнения операций, требования к безопасности, ограничения.",
    indexBody: `# Norms

Внутренние нормативные документы TaskFlow: правила выполнения операций, требования к безопасности, ограничения.

Сюда НЕ пишут нормативные законы (44-ФЗ, 223-ФЗ, GDPR) — это для отдельных проектов (например, «Бизнес Опора»). Здесь — то, что действует внутри системы: правила обращения с секретами, регламенты деплоя, политики доступа.`,
  },
  {
    name: "Knowledge Base",
    description: "Накопленные знания о мире TaskFlow и смежных системах: что как устроено, какие грабли, какие особенности.",
    indexBody: `# Knowledge Base

Накопленные знания о мире TaskFlow и смежных системах: что как устроено, какие грабли, какие особенности.

Сюда попадают находки разведки, наблюдения по ходу работы, отметки о странных особенностях моделей и инфраструктуры. Это рабочий журнал знаний, пополняемый самими ролями.`,
  },
  {
    name: "Projects",
    description: "Документация по конкретным проектам TaskFlow: что за проект, его контекст, файлы, договорённости, с чем связан. Сюда переносится то, что относится к конкретному проекту и пригодится при следующей работе с ним.",
    indexBody: `# Projects

Документация по конкретным проектам TaskFlow. Сюда переносится то, что относится к конкретному проекту и пригодится при следующей работе с ним: что за проект, какой у него контекст, какие договорённости, с чем связан.

Это НЕ замена projects.notes_folder_id (там рабочая документация проекта, привязанная к задачам). Сюда — знания о самом проекте, выжимки, контекст для нового участника.

## Пример разделения

- Текущая работа по проекту → projects.notes_folder_id (как раньше).
- Что это за проект и зачем → сюда, в Projects/<project>.`,
  },
];

const dbPath = process.env.DB_PATH || path.resolve("taskflow.db");
if (!fs.existsSync(dbPath)) {
  if (dryRun) {
    console.error(`[dry-run] БД ${dbPath} не существует; на живой проверке скрипт остановился бы.`);
    process.exit(0);
  }
  throw new Error(`БД не найдена: ${dbPath}. Запустите сервер хотя бы раз, чтобы миграции применились.`);
}
const readonly = dryRun;
const database = new Database(dbPath, { readonly, fileMustExist: true });

try {
  const root = database
    .prepare("SELECT id, name FROM journal_folders WHERE is_kb_root = 1 LIMIT 1")
    .get() as { id: number; name: string } | undefined;

  let rootId: number;
  if (root) {
    rootId = root.id;
    console.log(`[ok] корневая папка уже есть: id=${rootId} name="${root.name}"`);
  } else if (dryRun) {
    rootId = -1;
    console.log(`[dry-run] будет создана корневая папка: name="${rootName}"`);
  } else {
    const info = database
      .prepare(
        `INSERT INTO journal_folders (parent_id, name, position, is_kb_root)
         VALUES (NULL, ?, 0, 1)`,
      )
      .run(rootName);
    rootId = Number(info.lastInsertRowid);
    console.log(`[created] корневая папка: id=${rootId} name="${rootName}"`);
  }

  for (const sub of SUBFOLDERS) {
    const existing = database
      .prepare(
        "SELECT id, name FROM journal_folders WHERE parent_id = ? AND name = ?",
      )
      .get(rootId >= 0 ? rootId : -1, sub.name) as { id: number; name: string } | undefined;

    let subId: number;
    if (existing) {
      subId = existing.id;
      console.log(`[ok] подпапка уже есть: id=${subId} name="${sub.name}"`);
    } else if (dryRun) {
      subId = -1;
      console.log(`[dry-run] будет создана подпапка: name="${sub.name}" (под "${rootName}")`);
    } else {
      const info = database
        .prepare(
          `INSERT INTO journal_folders (parent_id, name, position, is_kb_root)
           VALUES (?, ?, 0, 0)`,
        )
        .run(rootId, sub.name);
      subId = Number(info.lastInsertRowid);
      console.log(`[created] подпапка: id=${subId} name="${sub.name}"`);
    }

    // Индексная заметка: ищем по folder_id+title.
    if (subId < 0) {
      console.log(`[dry-run] будет создана заметка _index.md в "${sub.name}"`);
      continue;
    }
    const noteTitle = "_index.md";
    const noteBody = sub.indexBody;
    const existingNote = database
      .prepare("SELECT id, title FROM user_notes WHERE folder_id = ? AND title = ?")
      .get(subId, noteTitle) as { id: string; title: string } | undefined;

    if (existingNote) {
      console.log(`[ok] заметка _index.md уже есть: id=${existingNote.id}`);
    } else if (dryRun) {
      console.log(`[dry-run] будет создана заметка _index.md в "${sub.name}"`);
    } else {
      const noteId = randomUUID();
      const content = markdownToTiptap(noteBody);
      database
        .prepare(
          `INSERT INTO user_notes (id, title, content, folder_id)
           VALUES (?, ?, ?, ?)`,
        )
        .run(noteId, noteTitle, content, subId);
      console.log(`[created] заметка _index.md: id=${noteId} в "${sub.name}"`);
    }
  }

  console.log(`\n${dryRun ? "DRY-RUN ЗАВЕРШЁН" : "BOOTSTRAP ЗАВЕРШЁН"}: корень id=${rootId} name="${rootName}"`);
} finally {
  database.close();
}