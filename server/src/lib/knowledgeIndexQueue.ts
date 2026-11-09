// Очередь индексации заметок (09.11.2026). Владелец: «сразу при сохранении —
// заметка через несколько секунд в базе знаний». До этого в индекс попадало
// только суточным прогоном (runKnowledgeSync), и правка жила в поиске с
// задержкой до суток.
//
// Почему очередь, а не вызов из PATCH: автосохранение в редакторе заметки
// срабатывает каждые ~800 мс. Заливать документ на каждое нажатие — это
// десятки заливок и разборов в минуту на CPU-модели. Дебаунс собирает серию
// правок в одно задание, а один прогон за раз не даёт двум заданиям
// одновременно перезаливать один и тот же датасет.
import db from "../db.js";
import { reindexNote } from "./knowledgeSync.js";

/** Правка «устоялась» — столько ждём после сохранения. */
export const DEBOUNCE_MS = 10_000;
/** Как часто смотрим, не пора ли что-то заливать. */
export const TICK_MS = 5_000;
/** Больше трёх попыток на одну правку — уже не случайность, а поломка. */
export const MAX_ATTEMPTS = 3;
/** Пауза перед повтором: упавший RAGFlow не должен молотить вхолостую. */
export const RETRY_MS = 60_000;
/** Задание «в работе» дольше этого — брошенное: процесс упал на середине. */
export const STUCK_MS = 10 * 60_000;

export type IndexStatus = "queued" | "running" | "done" | "error";

export type IndexState = {
  note_id: string;
  dataset_id: string | null;
  status: IndexStatus;
  attempts: number;
  error: string | null;
  ragflow_doc_id: string | null;
  queued_at: string;
  finished_at: string | null;
};

const iso = (at: number) => new Date(at).toISOString();

/**
 * Поставить заметку в очередь. Повторное сохранение перезапускает отсчёт
 * дебаунса и снимает прежнюю ошибку: человек правит заметку — он вправе
 * ждать, что она уедет в индекс.
 */
export function enqueueNoteIndex(noteId: string): void {
  db.prepare(
    `INSERT INTO knowledge_index_jobs (note_id, dataset_id, queued_at, attempts, status, error, ragflow_doc_id, finished_at)
     VALUES (?, NULL, ?, 0, 'queued', NULL, NULL, NULL)
     ON CONFLICT(note_id) DO UPDATE SET
       queued_at = excluded.queued_at,
       status = 'queued',
       attempts = 0,
       error = NULL,
       finished_at = NULL`,
  ).run(noteId, iso(Date.now()));
}

/** Состояние индексации заметки — его показывает дневник рядом с заголовком. */
export function indexState(noteId: string): IndexState | null {
  return (
    (db
      .prepare("SELECT * FROM knowledge_index_jobs WHERE note_id = ?")
      .get(noteId) as IndexState | undefined) ?? null
  );
}

/**
 * Заметку удалили — задание больше не нужно. Документ из RAGFlow уберёт
 * суточный прогон: он умеет удалять своё (по имени `taskflow-<id>.md`), а
 * ходить в чужой датасет ради уже несуществующей заметки здесь незачем.
 */
export function forgetNoteIndex(noteId: string): void {
  db.prepare("DELETE FROM knowledge_index_jobs WHERE note_id = ?").run(noteId);
}

/**
 * Обработать одно готовое задание. Возвращает число обработанных: 1 — что-то
 * залили (успешно или нет), 0 — было нечего делать.
 */
export async function runDueJobs(now: number = Date.now()): Promise<number> {
  // Задание, брошенное упавшим процессом, возвращаем в очередь: иначе оно
  // висит «в работе» вечно, а заметки молча не попадают в поиск.
  db.prepare(
    `UPDATE knowledge_index_jobs
        SET status = 'queued', queued_at = ?, error = COALESCE(error, 'задание прервалось')
      WHERE status = 'running' AND queued_at <= ?`,
  ).run(iso(now), iso(now - STUCK_MS));

  const due = db
    .prepare(
      `SELECT note_id, attempts FROM knowledge_index_jobs
        WHERE status = 'queued' AND queued_at <= ?
        ORDER BY queued_at LIMIT 1`,
    )
    .get(iso(now - DEBOUNCE_MS)) as { note_id: string; attempts: number } | undefined;
  if (!due) return 0;

  db.prepare("UPDATE knowledge_index_jobs SET status = 'running', attempts = attempts + 1 WHERE note_id = ?").run(
    due.note_id,
  );

  try {
    const done = await reindexNote(due.note_id);
    db.prepare(
      `UPDATE knowledge_index_jobs
          SET status = 'done', dataset_id = ?, ragflow_doc_id = ?, error = NULL, finished_at = ?
        WHERE note_id = ?`,
    ).run(done.dataset, done.document_id, iso(now), due.note_id);
  } catch (error) {
    const attempts = due.attempts + 1;
    const message = error instanceof Error ? error.message : String(error);
    if (attempts >= MAX_ATTEMPTS) {
      db.prepare(
        "UPDATE knowledge_index_jobs SET status = 'error', error = ?, finished_at = ? WHERE note_id = ?",
      ).run(message, iso(now), due.note_id);
    } else {
      db.prepare(
        "UPDATE knowledge_index_jobs SET status = 'queued', error = ?, queued_at = ? WHERE note_id = ?",
      ).run(message, iso(now + RETRY_MS), due.note_id);
    }
  }
  return 1;
}

/** Запуск фоновой очереди. Возвращает функцию остановки. */
export function startKnowledgeIndexWorker(): () => void {
  const timer = setInterval(() => {
    void runDueJobs().catch(() => {
      // Тихо: о поломке скажет состояние задания (status = error) и сторож.
    });
  }, TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
