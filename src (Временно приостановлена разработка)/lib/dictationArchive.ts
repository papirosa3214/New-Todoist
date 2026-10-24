import { API_BASE_URL } from "../api/client";

// ═══════════ ОЧЕРЕДЬ ВЫГРУЗКИ АУДИО ДИКТОВОК ═══════════
//
// Задача от владельца 18.08.2026: аудио не удалять сразу после распознавания, а
// копить на телефоне и выгружать на .110, когда он доступен; удалять свою копию
// ТОЛЬКО после подтверждения сервером.
//
// IndexedDB, а не localStorage: там хранятся байты (Blob), localStorage умеет
// только строки, и base64 раздул бы записи на треть.
//
// Ключевое правило: запись удаляется из очереди исключительно при 2xx. Любой
// другой исход — сеть недоступна, сервер не обновлён и маршрута ещё нет (404),
// ошибка авторизации — оставляет запись на месте. На момент написания
// серверный маршрут существует в коде, но НЕ РАЗВЁРНУТ: владелец запретил
// перезапускать сервер («сейчас вообще нельзя его перезапускать»), поэтому
// первые выгрузки будут получать 404 и терпеливо ждать в очереди. Это не
// авария, а ожидаемое состояние — и именно поэтому удаление привязано к 2xx, а
// не к «попытались отправить».

const DB_NAME = "dictation-archive";
const STORE = "pending";
const DB_VERSION = 1;

export interface PendingRecording {
  id: string;
  blob: Blob;
  mime: string;
  text: string;
  engine: string;
  recordedAt: string;
  /** Сколько раз пытались выгрузить — для показа и для диагностики. */
  attempts: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());

export function subscribeArchiveQueue(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function queueRecording(entry: {
  blob: Blob;
  mime: string;
  text: string;
  engine: string;
}): Promise<void> {
  const record: PendingRecording = {
    id: crypto.randomUUID(),
    blob: entry.blob,
    mime: entry.mime,
    text: entry.text,
    engine: entry.engine,
    recordedAt: new Date().toISOString(),
    attempts: 0,
  };
  await tx("readwrite", (store) => store.add(record));
  emit();
  // Пробуем сразу: чаще всего .110 в той же сети и запись уйдёт немедленно.
  void flushArchiveQueue();
}

export async function pendingCount(): Promise<number> {
  try {
    return await tx<number>("readonly", (store) => store.count());
  } catch {
    // IndexedDB недоступна (приватный режим и подобное) — очереди просто нет.
    return 0;
  }
}

let flushing = false;

/**
 * Пытается выгрузить всё, что накопилось. Безопасно звать часто: повторный
 * вызов во время работы игнорируется.
 */
export async function flushArchiveQueue(): Promise<{ sent: number; left: number }> {
  if (flushing) return { sent: 0, left: await pendingCount() };
  flushing = true;
  let sent = 0;
  try {
    const items = await tx<PendingRecording[]>("readonly", (store) =>
      store.getAll() as IDBRequest<PendingRecording[]>,
    );
    const token = window.localStorage.getItem("taskflow_token");
    if (!token) return { sent: 0, left: items.length };

    for (const item of items) {
      const params = new URLSearchParams({
        text: item.text,
        engine: item.engine,
        recordedAt: item.recordedAt,
      });
      let ok = false;
      try {
        const res = await fetch(`${API_BASE_URL}/api/audio/archive?${params}`, {
          method: "POST",
          headers: {
            "content-type": item.mime,
            authorization: `Bearer ${token}`,
          },
          body: item.blob,
        });
        ok = res.ok;
      } catch {
        // Сети нет — прекращаем обход целиком: остальные записи ждёт то же.
        break;
      }
      if (ok) {
        await tx("readwrite", (store) => store.delete(item.id));
        sent += 1;
      } else {
        // Не 2xx (в том числе 404, пока маршрут не развёрнут) — запись
        // остаётся, увеличиваем счётчик попыток и идём дальше.
        await tx("readwrite", (store) =>
          store.put({ ...item, attempts: item.attempts + 1 }),
        );
        break;
      }
    }
  } catch {
    /* хранилище недоступно — попробуем в следующий раз */
  } finally {
    flushing = false;
    emit();
  }
  return { sent, left: await pendingCount() };
}
