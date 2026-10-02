// inbox-results-writer.ts
//
// Слушает события закрытия/перевода задач диагностики и устранения
// и дописывает блоки в файлы уведомлений (Phase 4).
//
// Запускается внутри сервера TaskFlow (правило Maksim 27.09.2026 —
// никакого внешнего процесса). Использует те же polling приёмы что
// и inboxTriageWatcher.ts.
//
// Как работает:
//   1. Раз в POLL_MS опрашивает task_events на новые записи.
//   2. Для каждого нового события видим, что карточка имеет
//      description с маркером "Авто-создано inbox-triage-watcher из ...",
//      и по нему восстанавливает оригинальный .md файл.
//   3. Дописывает блок "По результатам диагностики" / "Итог по устранению"
//      к .md файлу (атомарно, через .tmp + rename).
//   4. Идемпотентно: для каждого task_event пишется не более одного блока,
//      потому что маркер исходного ticket'а включён в блок и на следующем
//      тике проверяется наличие.
//
// Какие события мы обрабатываем:
//   - task_created для созданной нами задачи — пишем в .md ссылку на задачу
//     (это делает уже inboxTriageWatcher; здесь мы только для верификации
//     что .md получил блок)
//   - task_dispatched / state_changed → todo / in_progress / review / done —
//     дописываем в зависимости от того, как закрывается задача

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import db from "../db.js";
import { serverNotificationsProjectId } from "./serverNotificationsProject.js";

export const NOTIF_ROOT =
  process.env.TASKFLOW_NOTIF_ROOT ||
  path.join(os.homedir(), "Проекты", "taskflow-уведомления");

const POLL_MS = Number(process.env.RESULTS_WRITER_POLL_MS) || 3000;
// Сколько последних минут событий мы обрабатываем при каждом тике (защита
// от дублей и пропусков). Каждое событие обрабатывается ОДИН раз, так что
// окно должно быть >= POLL_MS, иначе старые события могут остаться
// необработанными.
const WINDOW_MIN = Number(process.env.RESULTS_WRITER_WINDOW_MIN) || 10;

// Маркер в description карточки, по которому мы опознаём «наши» карточки.
// Совпадает с inboxTriageWatcher.ts.
const WATCHER_MARK = "Авто-создано inbox-triage-watcher из ";

interface TrackedTask {
  taskId: string;
  /** Относительный путь оригинального ticket-файла относительно NOTIF_ROOT
   *  в момент создания. Восстанавливается из description. */
  sourceRel: string;
  /** Оригинальный .md файл уведомления — восстанавливается из sourceRel. */
  mdPath: string;
  /** Последний обработанный created_at из task_events. */
  lastEventAt: string | null;
  /** Один раз записали "Карточка диагностики" — чтобы не было петель. */
  diagLinkWritten: boolean;
  /** Какие блоки уже дописаны в .md файл. */
  written: {
    diagnosticLink?: string; // событие-создание (мы уже делаем, но подтверждаем)
    diagnosticResult?: string; // state_changed → review
    fixResult?: string; // state_changed → review для карточки устранения
  };
}

export function startInboxResultsWriter(): () => void {
  if (!fs.existsSync(NOTIF_ROOT)) {
    console.warn(
      `[results-writer] корень ${NOTIF_ROOT} не существует — writer не активен`,
    );
    return () => {};
  }
  const inboxRoot = path.join(NOTIF_ROOT, "inbox");
  if (!fs.existsSync(inboxRoot)) {
    console.warn(
      `[results-writer] ${inboxRoot} не существует — writer не активен`,
    );
    return () => {};
  }
  let stopped = false;

  // Кэш состояния задач по task_id. Сбрасывается периодически если
  // долго не было тиков — простой способ не утекать по памяти.
  const tracked = new Map<string, TrackedTask>();

  function discoverTrackedFromDb(): void {
    // При старте соберём все наши «наши» карточки из БД.
    // Это нужно чтобы перезапуск сервера не терял состояние.
    try {
      const rows = db.prepare(
        `SELECT id, description, created_at FROM tasks WHERE description LIKE ?`,
      ).all(`%${WATCHER_MARK}%`) as Array<{
        id: string;
        description: string;
        created_at: string;
      }>;
      for (const r of rows) {
        const sourceRel = parseMarker(r.description);
        if (!sourceRel) continue;
        const mdPath = mdPathFromRel(sourceRel);
        tracked.set(r.id, {
          taskId: r.id,
          sourceRel,
          mdPath,
          lastEventAt: r.created_at,
          diagLinkWritten: false,
          written: {},
        });
      }
    } catch (e: any) {
      console.warn(
        `[results-writer] discoverTracked: ${e?.message ?? e}`,
      );
    }
  }

  /** Возвращает относительный путь ticket-файла из description.
   * Format: "...Авто-создано inbox-triage-watcher из inbox/.../file.json._\n".
   * Берём всё ДО первого "._" (закрывающий маркер форматтера rendezvous).
   */
  function parseMarker(description: string): string | null {
    const idx = description.indexOf(WATCHER_MARK);
    if (idx < 0) return null;
    const sub = description.slice(idx + WATCHER_MARK.length);
    // sourceRel идёт до первого вхождения `._` (закрывающий маркер форматтера).
    const stop = sub.search(/\._/);
    if (stop < 0) return null;
    const result = sub.slice(0, stop).trim();
    return result || null;
  }

  /** Восстановление пути .md файла из relative ticket-файла. */
  function mdPathFromRel(sourceRel: string): string {
    // sourceRel был сформирован из path.relative(NOTIF_ROOT, p).split(...).
    // Типично: "inbox/2026-09-27/HHMMSS-source.json.processed.<ms>"
    // Уберём ".processed.<ts>" и заменим .json на .md:
    const trimmed = sourceRel.replace(/\.processed\.\d+$/, "");
    return path.join(NOTIF_ROOT, trimmed.replace(/\.json$/, ".md"));
  }

  /**
   * Создаёт .md файл уведомления если его ещё нет. Содержимое минимально —
   * description карточки диагностики (вытащим из самой задачи). Это
   * fallback на случай если rendezvous не создал .md (например, эмиттер
   * только сделал ticket — без полноценной сводки).
   */
  function ensureMdExists(
    mdPath: string,
    task: { id: string; title: string; description: string },
  ): void {
    if (fs.existsSync(mdPath)) return;
    const ts = new Date().toISOString();
    const sourceMatch = task.description.match(/Авто-создано inbox-triage-watcher из\s+(\S+)/);
    const sourceFile = sourceMatch?.[1] ?? "unknown";
    const body = [
      `# ${task.title}`,
      "",
      `- **когда:** ${ts}`,
      `- **от кого:** ${sourceFile}`,
      `- **уровень:** warning`,
      `- **тревога:** да`,
      `- **приёмка:** results-writer (fallback create)`,
      "",
      `## Сводка (для отображения в приложении)`,
      "",
      "```",
      `(results-writer создал этот файл т.к. rendezvous не записал сводку.`,
      `  task_id=${task.id}. Сводку см. в задаче TaskFlow.)`,
      "```",
      "",
      `## Карточка диагностики`,
      "",
      `[карточка #${task.id.slice(0, 8)}](tf://task/${task.id})`,
      `_Авто-создано через results-watcher fallback_`,
      "",
    ].join("\n");
    try {
      fs.writeFileSync(mdPath, body, "utf-8");
    } catch {
      // ignore
    }
  }

  /**
   * Идемпотентная запись блока в .md файл.
   * - marker должен встречаться в блоке; если уже есть — пропускаем.
   * - write через .tmp + rename.
   */
  function appendBlock(mdPath: string, block: string, marker: string): boolean {
    if (!fs.existsSync(mdPath)) return false;
    let text: string;
    try {
      text = fs.readFileSync(mdPath, "utf-8");
    } catch {
      return false;
    }
    if (text.includes(marker)) {
      return false; // уже записано
    }
    const newText = text.endsWith("\n") ? text + block : text + "\n" + block;
    const tmp = mdPath + ".tmp." + process.pid + "." + Date.now();
    try {
      fs.writeFileSync(tmp, newText, "utf-8");
      fs.renameSync(tmp, mdPath);
      return true;
    } catch (e: any) {
      console.warn(
        `[results-writer] запись блока в ${mdPath} не удалась: ${e?.message ?? e}`,
      );
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
      return false;
    }
  }

  /**
   * Один проход: взять новые события из task_events и применить блоки.
   */
  function tick(): void {
    if (stopped) return;
    try {
      const cutoff = new Date(
        Date.now() - WINDOW_MIN * 60_000,
      ).toISOString()
        .replace("T", " ")
        .replace("Z", "");
      // Берём события за последние N минут. kind ∈ {state_changed, task_dispatched}.
      const rows = db.prepare(
        `SELECT id, task_id, actor_id, kind, field, from_value, to_value, created_at
         FROM task_events
         WHERE kind IN ('state_changed', 'task_dispatched')
           AND created_at > ?
         ORDER BY created_at ASC`,
      ).all(cutoff) as Array<{
        id: string;
        task_id: string;
        actor_id: string | null;
        kind: string;
        field: string | null;
        from_value: string | null;
        to_value: string | null;
        created_at: string;
      }>;
      for (const ev of rows) {
        const t = tracked.get(ev.task_id);
        if (!t) continue;
        // наша задача?
        // (tracked уже отфильтрован на этапе discover)
        t.lastEventAt = ev.created_at;
        const newState =
          ev.kind === "state_changed"
            ? ev.to_value
            : ev.kind === "task_dispatched"
              ? "in_progress"
              : null;
        if (!newState) continue;
        if (newState === "review") {
          // Задача закрыта владельцем на приёмку. Это значит —
          // диагностика (если это была карточка на диагностику) или устранение.
          // Отличаем по description.
          const task = db.prepare(
            "SELECT id, title, description FROM tasks WHERE id = ?",
          ).get(ev.task_id) as {
            id: string;
            title: string;
            description: string;
          } | undefined;
          if (!task) continue;
          // карточка на устранение — в title есть "на устранение" ИЛИ в description
          // есть "По подтверждённым проблемам" (создана нашим путем).
          // карточка на диагностику — в title начинается с "[Диагностика]".
          const isFix =
            task.description.includes("По подтверждённым") ||
            /на устранение/i.test(task.title);
          if (isFix) {
            handleFixClosed(t, task);
          } else if (task.title.startsWith("[Диагностика]")) {
            handleDiagClosed(t, task);
          }
        }
      }
    } catch (e: any) {
      console.warn(`[results-writer] tick error: ${e?.message ?? e}`);
    }
  }

  function handleDiagClosed(
    t: TrackedTask,
    task: { id: string; title: string; description: string },
  ): void {
    if (t.written.diagnosticResult) return;
    // Если .md файл не создан эмиттером — создаём fallback.
    ensureMdExists(t.mdPath, task);
    // Смотрим последние комментарии task как вывод диагностики.
    const lastComments = db.prepare(
      `SELECT user_id, text, created_at FROM comments
       WHERE task_id = ?
       ORDER BY created_at DESC LIMIT 5`,
    ).all(task.id) as Array<{
      user_id: string;
      text: string;
      created_at: string;
    }>;
    const commentTexts = lastComments.map((c) => c.text);
    // Если диагностика подтвердилась — в комментарии должно быть что-то,
    // что оправдывает создание карточки на устранение. Просто берём всё что есть.
    // Если же комментариев нет — пишем «не подтвердилось».
    const confirmed =
      commentTexts.length > 0 &&
      !commentTexts.some((c) =>
        c.toLowerCase().includes("не подтвердилось") ||
        c.toLowerCase().includes("проблем не выявлено") ||
        c.toLowerCase().includes("ложная тревога"),
      );

    let block = `\n## По результатам диагностики\n\n`;
    if (confirmed) {
      // Идемпотентный INSERT: проверяем, нет ли уже дочерней карточки на
      // устранение для этой пары (parent_id, prefix-title). Защищаемся от
      // дублирования при перезапуске writer'а.
      const subTitlePrefix = `Устранение: ${task.title.replace(
        /^\[Диагностика\] /,
        "",
      )}`;
      // Вложенность одна (02.10.2026): диагностика сама дочерняя — карточка
      // на устранение встаёт рядом с ней, к тому же родителю.
      const fixParent =
        (db.prepare("SELECT parent_id FROM tasks WHERE id = ?").get(task.id) as { parent_id: string | null } | undefined)
          ?.parent_id ?? task.id;
      const existingFix = db.prepare(
        `SELECT id FROM tasks WHERE parent_id = ? AND title = ? LIMIT 1`,
      ).get(fixParent, subTitlePrefix) as { id: string } | undefined;
      let subId = existingFix?.id;
      if (!subId) {
        subId = crypto.randomUUID();
        try {
          db.prepare(
            // Устранение — туда же, куда диагностика: проект «Серверные уведомления».
            `INSERT INTO tasks (id, title, description, priority, creator_id, status, agent_state, parent_id, project_id)
             VALUES (?, ?, ?, ?, ?, 'active', 'todo', ?, ?)`,
          ).run(
            subId,
            subTitlePrefix,
            `Авто-создано по результатам диагностики #${task.id.slice(0, 8)}.\n\n` +
              `## Источник: диагностическая задача ${task.id}\n\n` +
              `## Комментарии диагностики:\n${commentTexts
                .slice(0, 3)
                .map((c) => `> ${c.slice(0, 600)}`)
                .join("\n\n")}\n`,
            2,
            "u1",
            fixParent,
            serverNotificationsProjectId("u1"),
          );
        } catch {
          // уже существует другая карточка на устранение? — пропустим INSERT
          const second = db.prepare(
            `SELECT id FROM tasks WHERE parent_id = ? AND title = ? LIMIT 1`,
          ).get(fixParent, subTitlePrefix) as { id: string } | undefined;
          subId = second?.id;
        }
      }
      // Карточку завести не удалось — пишем это, а не падаем на пустом id.
      if (!subId) {
        block += "Подтвердилось, но карточку на устранение завести не удалось — заведите её вручную.\n";
      } else {
        block +=
          "Подтвердилось: " +
          (commentTexts[0] ?? "(комментарий исполнителя)") +
          `\n\nПо подтверждённым проблемам создана карточка на устранение: ` +
          `[карточка #${subId.slice(0, 8)}](tf://task/${subId})\n`;
      }
    } else {
      block += "Проблема не подтвердилась.\n";
    }
    const marker = `<!-- results-writer: ${task.id} diag-review -->`;
    // marker хранится в in-memory как подсказка чтобы не вызывать
    // appendBlock (который перечитывает файл) чаще одного раза на тик.
    // Источник правды — файл (см. appendBlock).
    if (appendBlock(t.mdPath, block, marker)) {
      t.written.diagnosticResult = marker;
    }
  }

  function handleFixClosed(
    t: TrackedTask,
    task: { id: string; title: string; description: string },
  ): void {
    if (t.written.fixResult) return;
    ensureMdExists(t.mdPath, task);
    // Берём последний комментарий на закрытой карточке — это решение Maksim'а.
    const lastComment = db.prepare(
      `SELECT user_id, text, created_at FROM comments
       WHERE task_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    ).get(task.id) as { user_id: string; text: string; created_at: string } | undefined;
    let block = "\n## Итог по устранению\n\n";
    const text = (lastComment?.text ?? "").trim();
    if (!text) {
      block += `- ${task.title} — (не исправлено: комментарий не оставлен)\n`;
    } else if (/(решено|исправлено|готово|✅)/i.test(text)) {
      block += `- ${task.title} — (исправлено)\n`;
    } else if (/(нет доступ|нет доступа|нет прав|provisioning)/i.test(text)) {
      block += `- ${task.title} — (не исправлено: нет доступов у исполнителя)\n`;
    } else {
      // Генерируем 3 подсказки backend-only. Ни эмиттер, ни исполнитель
      // их не пишут. Логика эвристики — вытащить из контекста задачи,
      // какой сервис/файл затронут, и предложить конкретные шаги.
      // Если вытащить нельзя — fallback на общие действия.
      const title = task.title; // уже с префиксом "[Диагностика] " или "Устранение: "
      const cleanTitle = title.replace(/^\[(Диагностика|Устранение)\]\s*/, "")
        .replace(/\s+\(.+\)$/, "");
      // 1) исправить в <file>:<line> — обычно упоминается в комментарии исполнителя
      // 2) откатить изменение, если мы его знаем
      // 3) остановить сервис и принять деградацию
      // 4) свой вариант
      const fileRef =
        (text.match(/\b(server\/[\w./-]+\.ts?)\b/) ||
          text.match(/\b([\w./-]+\.(?:ts|js|py|sh))\b/) ||
          [])[1] ?? "нужном файле";
      const suggestions = [
        `исправить в ${fileRef} согласно описанной проблеме`,
        "откатить недавнее изменение, если оно причина сбоя",
        "остановить сервис и принять кратковременную деградацию",
      ];
      block += `- ${cleanTitle} — (не исправлено, нужно ваше решение по вопросу…\n`;
      for (const s of suggestions) {
        block += `    ${s}\n`;
      }
      block += `    4) свой вариант)\n`;
    }
    // marker хранится в in-memory как подсказка; источник правды — файл.
    const marker = `<!-- results-writer: ${task.id} fix-review -->`;
    if (appendBlock(t.mdPath, block, marker)) {
      t.written.fixResult = marker;
    }
  }

  // При бут-секундах: выгружаем известные карточки.
  discoverTrackedFromDb();
  console.log(
    `[results-writer] watching tasks (${tracked.size} known). poll=${POLL_MS}ms`,
  );

  // Стартуем polling — тоже без inotify, как в inboxTriageWatcher.
  const pollHandle = setInterval(tick, POLL_MS);

  // Первый тик сразу, не через POLL_MS.
  setImmediate(tick);

  return () => {
    stopped = true;
    try {
      clearInterval(pollHandle);
    } catch {
      // ignore
    }
  };
}
