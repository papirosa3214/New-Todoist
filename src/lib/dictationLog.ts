// ═══════════ ЖУРНАЛ ДИКТОВОК (диагностика для владельца) ═══════════
//
// Зачем: 18.08.2026 нормализация аббревиатур и переход на модель turbo были
// сделаны ОДНИМ заходом, и стало не отличить, кто исправил «осаго» → «ОСАГО» —
// словарь или сама модель. Владелец попросил переключатель, чтобы видеть это
// самому, не дожидаясь, пока кто-то полезет в логи устройства.
//
// Пишем ровно то, что нужно для этого вопроса: текст ОТ МОДЕЛИ как есть и текст
// после наших правок. Если они совпадают — модель уже пишет верно, словарь ни
// при чём. Если отличаются — видно, что именно поправил словарь.
//
// localStorage, а не память: ответ на вопрос «кто исправил» нужен после
// перезапуска приложения тоже. Ограничение по числу записей обязательно —
// иначе журнал растёт бесконечно и в localStorage кончается место.

const ENABLED_KEY = "dictationLog.enabled";
const ENTRIES_KEY = "dictationLog.entries";
// 200, а не 20: владелец сказал, что история нужна обязательно. Записи —
// только текст, вес мизерный; localStorage переживает и переустановку
// приложения (лежит в контейнере данных, как и скачанная модель).
const MAX_ENTRIES = 200;

export interface DictationLogEntry {
  /** Время в ISO — форматируется при выводе, не при записи. */
  at: string;
  /** whisper | apple | server — кто распознал. */
  engine: string;
  /** Текст, как его отдал движок, без наших правок. */
  raw: string;
  /** Текст после нормализации (аббревиатуры, заглавная буква). */
  normalized: string;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeDictationLog(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isDictationLogEnabled(): boolean {
  try {
    return window.localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    // Приватный режим/запрет хранилища — журнал просто выключен, не падаем.
    return false;
  }
}

export function setDictationLogEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
  } catch {
    /* см. выше */
  }
  emit();
}

export function readDictationLog(): DictationLogEntry[] {
  try {
    const raw = window.localStorage.getItem(ENTRIES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DictationLogEntry[]) : [];
  } catch {
    // Повреждённый JSON не должен ломать экран настроек.
    return [];
  }
}

/** Дописывает запись, если журнал включён. Новые — сверху. */
export function addDictationLogEntry(
  entry: Omit<DictationLogEntry, "at">,
): void {
  if (!isDictationLogEnabled()) return;
  const next = [{ at: new Date().toISOString(), ...entry }, ...readDictationLog()]
    .slice(0, MAX_ENTRIES);
  try {
    window.localStorage.setItem(ENTRIES_KEY, JSON.stringify(next));
  } catch {
    /* переполнение хранилища — молча, диагностика не важнее работы */
  }
  emit();
}

export function clearDictationLog(): void {
  try {
    window.localStorage.removeItem(ENTRIES_KEY);
  } catch {
    /* см. выше */
  }
  emit();
}
