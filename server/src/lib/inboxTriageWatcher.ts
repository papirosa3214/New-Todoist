// inbox-triage-watcher.ts
// Наблюдатель за ~/Проекты/taskflow-уведомления/inbox/*/_diagnostic/*.json.
//
// Когда rendezvous.py пишет ticket (потому что в уведомлении нашлась тревога),
// watcher ровно изнутри TaskFlow читает этот ticket и создаёт карточку на
// диагностику. Никакого HTTP-вызова снаружи, никаких внешних сервисов:
//
//   1. rendezvous.py пишет ticket — это та же машина, что и сервер.
//   2. fs.watch замечает новый .json под _diagnostic.
//   3. watcher читает, парсит, вытаскивает маркеры.
//   4. INSERT INTO tasks (от owner_id, priority=2).
//   5. Файл .json → переименован в .processed.<ts>; при неудаче —
//      в .failed.<ts> с телом ошибки. Идемпотентность: повторный запуск
//      с уже .processed файлом скип.
//
// Чистая интеграция (правило Maksim 27.09.2026): карточка создаётся только
// внутри серверного процесса TaskFlow. Внешних триггеров/HTTP-вызовов нет.
//
// Поведение watcher'а НЕ блокирует app.ready(): он стартует после listen().

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import db from "../db.js";
import { logEvent } from "../agentState.js";
import { serverNotificationsProjectId } from "./serverNotificationsProject.js";
import { dispatchPendingDiagnosticTasks } from "./diagnosticDispatch.js";

export const NOTIF_ROOT =
  process.env.TASKFLOW_NOTIF_ROOT ||
  path.join(os.homedir(), "Проекты", "taskflow-уведомления");

// Владелец (Максим) — автор всех авто-карточек. Без прав на сервис —
// исполнитель сам назначит руками, либо появится follow-up.
const OWNER_ID = process.env.TASKFLOW_OWNER_ID || "u1";

// Приоритет: 2 = высокий (1 — обычный, 3 — срочный, 4 — крит).
// Тревога в инфра-уведомлении — это «что-то сломалось», но не fire-alert.
const PRIORITY = 2;

// Таймаут debounce: если три файла упали за 50мс — обработаем все, но
// каждый не чаще раза в 200мс (один ticket = одна INSERT-транзакция).
const DEBOUNCE_MS = 200;

// Окно слежения: README говорит, что «заявка на диагностику» лежит в
// <day>/_diagnostic/<HHMMSS>-<source>.json
interface TriageTicket {
  ts: string;
  source: string;
  title: string;
  triage_lines: string[];
  full_text: string;
  status: "pending" | "dispatched" | "failed";
  dry_run: boolean;
}

export function startInboxTriageWatcher(): () => void {
  if (!fs.existsSync(NOTIF_ROOT)) {
    console.warn(
      `[inbox-triage] корень ${NOTIF_ROOT} не существует — watcher не активен`,
    );
    return () => {};
  }

  const inboxRoot = path.join(NOTIF_ROOT, "inbox");
  if (!fs.existsSync(inboxRoot)) {
    console.warn(
      `[inbox-triage] ${inboxRoot} не существует — watcher не активен`,
    );
    return () => {};
  }

  // Polling по mtime файла вместо inotify — надёжнее, потому что:
  // 1) fs.watch под Node 22 на крупных каталогах теряет события;
  // 2) rendezvous пишет файл одной ОПЕРАЦИЕЙ, и inotify может не поймать
  //    'rename' если watcher ещё не успел подцепить наблюдение за файл.
  // Polling раз в POLL_MS не нагружает: каталог небольшой, mtime есть всегда.
  const POLL_MS = 1000;
  const queue = new Set<string>();
  let busy = false;
  let stopped = false;
  let dispatchBusy = false;
  let lastDispatchAttempt = 0;
  const knownDirs = new Set<string>(scanDayDirs());
  // Проект заводится сразу при старте — Максим видит его, не дожидаясь первой
  // тревоги (27.09.2026).
  try {
    serverNotificationsProjectId(OWNER_ID);
  } catch (error) {
    console.warn("[inbox-triage] проект «Серверные уведомления»:", error);
  }

  const pollHandle = setInterval(() => {
    if (stopped) return;
    try {
      const days = scanDayDirs();
      for (const day of days) scanDayTickets(day);
      // Работающие дни помечаются; не нужно ничего удалять — файл сканера
      // обходится заново каждый тик.
      for (const d of knownDirs) days.has(d);
    } catch (e: any) {
      console.warn(`[inbox-triage] scan error: ${e?.message ?? e}`);
    }
    // Подцепить появившиеся files даже если watcher был стартован без них
    processQueue();
    // Новые и уже созданные диагностические карточки допускаются к
    // штатной durable-очереди независимо от ручного приёма обычных задач.
    // Повтор раз в минуту; назначенные/закрытые карточки выборка исключает.
    if (!dispatchBusy && Date.now() - lastDispatchAttempt >= 60_000) {
      dispatchBusy = true;
      lastDispatchAttempt = Date.now();
      void dispatchPendingDiagnosticTasks()
        .catch((error) => console.warn("[inbox-triage] dispatch scan:", error))
        .finally(() => { dispatchBusy = false; });
    }
  }, POLL_MS);

  function scanDayDirs(): Set<string> {
    const out = new Set<string>();
    if (!fs.existsSync(inboxRoot)) return out;
    for (const entry of fs.readdirSync(inboxRoot)) {
      const dayDir = path.join(inboxRoot, entry);
      try {
        if (fs.statSync(dayDir).isDirectory()) out.add(dayDir);
      } catch {
        // удалено
      }
    }
    return out;
  }

  function scanDayTickets(dayDir: string): void {
    const diag = path.join(dayDir, "_diagnostic");
    if (!fs.existsSync(diag)) return;
    for (const entry of fs.readdirSync(diag)) {
      if (!entry.endsWith(".json")) continue;
      const full = path.join(diag, entry);
      // пропускаем уже обработанные/упавшие
      if (entry.includes(".processed.") || entry.includes(".failed.")) continue;
      try {
        if (!fs.statSync(full).isFile()) continue;
      } catch {
        continue;
      }
      queue.add(full);
    }
  }

  function processQueue(): void {
    if (busy) {
      return;
    }
    if (queue.size === 0) return;
    busy = true;
    const next = queue.values().next().value as string | undefined;
    if (!next) {
      busy = false;
      setImmediate(processQueue);
      return;
    }
    queue.delete(next);
    try {
      const processed = processTicket(next);
      if (!processed) {
        // норма: либо уже был обработан
      }
    } catch (err: any) {
      console.error(`[inbox-triage] ошибка на ${next}: ${err?.message ?? err}`);
      markFailed(next, err?.message ?? String(err));
    } finally {
      busy = false;
      setImmediate(processQueue);
    }
  }

  function processTicket(p: string): boolean {
    if (
      p.endsWith(".processed") ||
      p.includes(".processed.") ||
      p.includes(".failed.")
    ) {
      return false;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(p, "utf-8");
    } catch (e: any) {
      if (e?.code === "ENOENT") return false;
      throw e;
    }
    let ticket: TriageTicket;
    try {
      ticket = JSON.parse(raw) as TriageTicket;
    } catch {
      markFailed(p, "ticket — не валидный JSON");
      return false;
    }
    if (ticket.status !== "pending") {
      renameProcessed(p);
      return false;
    }
    if (ticket.dry_run === true) {
      renameProcessed(p);
      return false;
    }

    const id = crypto.randomUUID();
    const title = `[Диагностика] ${ticket.title} (${ticket.source})`;
    const description =
      [
        `## Источник: ${ticket.source}`,
        `## Время тревоги: ${ticket.ts}`,
        ``,
        `## Что не работает`,
        ...ticket.triage_lines.map((l) => `- ${l}`),
        ``,
        `## Сводка уведомления (для контекста)`,
        "```",
        (ticket.full_text || "").slice(0, 4000),
        "```",
        ``,
        `_Авто-создано inbox-triage-watcher из ${
          path.relative(NOTIF_ROOT, p).replace(/\\/g, "/")
        }._`,
      ].join("\n");

    const txn = db.transaction(() => {
      db.prepare(
        `INSERT INTO tasks (
          id, title, description, priority, creator_id, status, agent_state, project_id
        ) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?)`,
      ).run(id, title, description, PRIORITY, OWNER_ID, serverNotificationsProjectId(OWNER_ID));
    });
    txn();

    // Лог события в tasks_events (чтобы лента активности увидела).
    try {
      logEvent({
        taskId: id,
        actorId: OWNER_ID,
        kind: "task_created",
        field: "task",
        toValue: title,
      });
    } catch {
      // logEvent — best effort; не валим watcher если таблица ещё не создана.
    }

    // Уведомление владельцу (одно короткое).
    try {
      db.prepare(
        `INSERT INTO notifications (id, user_id, type, task_id, text, actor_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        OWNER_ID,
        "auto_diagnostic_card",
        id,
        `Авто-создана карточка на диагностику: ${title.slice(0, 100)}`,
        OWNER_ID,
      );
    } catch {
      // best effort
    }

    // ДВУСТОРОННЯЯ СВЯЗЬ: дописать ссылку на созданную карточку в .md файл
    // уведомления, чтобы UI мог показать «Карточка диагностики → #uuid».
    // ticket-файл уже переименован (см. ниже), но md-файл оригинального
    // уведомления лежит в inbox/YYYY-MM-DD/<stem>.md рядом — там и
    // дописываем блок. Идемпотентно через marker.
    try {
      linkCardInMd(p, id);
    } catch (e: any) {
      console.warn(
        `[inbox-triage] не удалось дописать ссылку в .md: ${e?.message ?? e}`,
      );
    }

    renameProcessed(p);
    return true;
  }

  /**
   * Дописывает в .md файл уведомления блок `## Карточка диагностики`
   * со ссылкой на созданную карточку. Идемпотентно через marker в комментарии.
   *
   * ticketPath — это путь к ticket-файлу в `_diagnostic/`. Рядом с ним лежит
   * md-файл уведомления (с тем же stem). Параметр ticketPath передаётся
   * ДО его переименования в `.processed.<ts>`.
   */
  function linkCardInMd(ticketPath: string, taskId: string): void {
    // ticket: .../inbox/<day>/_diagnostic/<HHMMSS>-<source>.json
    // md:     .../inbox/<day>/<HHMMSS>-<source>.md
    // Сначала восстановим md path без переименования ticket:
    const dir = path.dirname(path.dirname(ticketPath)); // поднять на 1 уровень
    const fileBase = path.basename(ticketPath, ".json");
    const mdPath = path.join(dir, `${fileBase}.md`);
    if (!fs.existsSync(mdPath)) {
      // md создаётся эмиттером (rendezvous). Если эмиттер ticket не создал
      // (наш fallback), то дописывать некуда — UI прочитает .md из БД-задачи.
      // watcher уже сделал notification в БД и запись в file-fallback (если был).
      return;
    }
    // Если в tickets/tasks есть watcher-marker, .md точно наш.
    // marker однозначно указывает на запись одной и той же карточки:
    const marker = `<!-- inbox-triage-watcher: ${taskId} linked -->`;
    let text: string;
    try {
      text = fs.readFileSync(mdPath, "utf-8");
    } catch {
      return;
    }
    if (text.includes(marker)) {
      // уже связано — ничего не делаем
      return;
    }
    const block =
      `\n\n## Карточка диагностики\n\n` +
      `[карточка #${taskId.slice(0, 8)}](tf://task/${taskId})\n` +
      `_Авто-создано inbox-triage-watcher (${new Date().toISOString()})_ ${marker}\n`;
    // Атомарная запись: .tmp + rename
    const newText = text.endsWith("\n") ? text + block : text + "\n" + block;
    const tmp = mdPath + ".tmp." + process.pid + "." + Date.now();
    try {
      fs.writeFileSync(tmp, newText, "utf-8");
      fs.renameSync(tmp, mdPath);
    } catch (e: any) {
      console.warn(
        `[inbox-triage] appendToMd ${mdPath} не удалось: ${e?.message ?? e}`,
      );
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
    }
  }

  function renameProcessed(p: string): void {
    const ts = Date.now();
    const target = `${p}.processed.${ts}`;
    try {
      fs.renameSync(p, target);
    } catch {
      // уже переименован — норма.
    }
  }

  function markFailed(p: string, reason: string): void {
    const ts = Date.now();
    const target = `${p}.failed.${ts}`;
    try {
      fs.writeFileSync(
        target,
        JSON.stringify({ failed_at: new Date().toISOString(), reason }, null, 2),
        "utf-8",
      );
      fs.unlinkSync(p);
    } catch {
      // last resort: ничего не делаем — файл останется, ручной обработки
    }
  }

  function handleEvent(event: string, filename: string | null, dir: string) {
    if (!filename) return;
    if (event === "rename" && (filename.endsWith(".processed") || filename.includes(".failed."))) return;
    const full = path.join(dir, filename);
    if (!full.includes(`${path.sep}_diagnostic${path.sep}`)) return;
    if (!full.endsWith(".json")) return;
    queue.add(full);
    setTimeout(processQueue, DEBOUNCE_MS);
  }

  // Заглушка — оставлено как no-op, чтобы при патчах случайно не вызвать
  // удалённый inotify-код. Polling выше полностью покрывает наблюдение.
  void handleEvent;

  console.log(
    `[inbox-triage] polling ${inboxRoot} (every ${POLL_MS} ms)`,
  );

  return () => {
    stopped = true;
    try {
      clearInterval(pollHandle);
    } catch {
      // ignore
    }
  };
}
