// On-device распознавание речи и разбор диктовки на подзадачи (18.08.2026,
// прямая просьба: «мне задержка не нравится очень долгая» — весь текущий
// путь идёт через сеть до .110, on-device убирает сетевой round-trip).
//
// Нативный Swift-плагин — ios/App/App/LocalAIPlugin.swift. Требует iOS 26+
// и устройство с Apple Intelligence — на вебе и на телефонах без него
// registerPlugin просто не найдёт нативную реализацию, isAvailable()
// вернёт false, вызывающий код обязан упасть обратно на серверный путь
// (useTranscribeAudio/useSuggestSubtasksForDraft) — см. их правки этим же
// днём. Ничего не ломает для веб-версии — этот модуль на вебе просто
// никогда не считается доступным.
import { registerPlugin, Capacitor } from "@capacitor/core";

interface LocalAIPlugin {
  isAvailable(): Promise<{ llm: boolean; llmReason: string; asr: boolean }>;
  transcribe(opts: { audioBase64: string }): Promise<{ text: string }>;
  suggestSubtasks(opts: { text: string }): Promise<{ subtasks: string[] }>;
}

const LocalAI = registerPlugin<LocalAIPlugin>("LocalAI");

/** true только на нативном iOS — на вебе плагин физически не может
    существовать (FoundationModels/SFSpeechRecognizer — iOS API). Дешёвая
    проверка ДО похода в нативный мост, не полагаться на try/catch вокруг
    isAvailable() как на единственную защиту. */
function isNativeIOS(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

/** Кэш на время жизни вкладки — isAvailable() трогает SystemLanguageModel
    (не бесплатная проверка), а доступность Apple Intelligence на
    конкретном устройстве не меняется за время одной сессии приложения. */
let availabilityCache: Promise<{ llm: boolean; asr: boolean }> | null = null;

export function checkLocalAIAvailability(): Promise<{
  llm: boolean;
  asr: boolean;
}> {
  if (!isNativeIOS()) return Promise.resolve({ llm: false, asr: false });
  if (!availabilityCache) {
    availabilityCache = LocalAI.isAvailable()
      .then((r) => ({ llm: r.llm, asr: r.asr }))
      .catch(() => ({ llm: false, asr: false }));
  }
  return availabilityCache;
}

/** Blob → base64 без заголовка data:...;base64, — плагин ждёт голую
    строку. FileReader, не Buffer — этот файл идёт и в веб-бандл (Vite не
    отличает платформу на этапе сборки), Buffer там не существует. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// null — единый сигнал «используй сервер», без разницы, ПОЧЕМУ: платформа
// не native, Apple Intelligence недоступен на этом устройстве, или сам
// вызов упал (модель отказала, файл не записался, что угодно). On-device
// путь либо тихо срабатывает, либо тихо уступает место старому надёжному
// серверному — никогда не должен ломать функциональность, которая и без
// него работала весь день. try/catch здесь, а не в каждом вызывающем
// хуке — единообразный контракт на один call-site, а не размноженный по
// всем местам использования.

export async function transcribeOnDevice(blob: Blob): Promise<string | null> {
  try {
    const { asr } = await checkLocalAIAvailability();
    if (!asr) return null;
    const audioBase64 = await blobToBase64(blob);
    const { text } = await LocalAI.transcribe({ audioBase64 });
    return text;
  } catch {
    return null;
  }
}

export async function suggestSubtasksOnDevice(
  text: string,
): Promise<string[] | null> {
  try {
    const { llm } = await checkLocalAIAvailability();
    if (!llm) return null;
    const { subtasks } = await LocalAI.suggestSubtasks({ text });
    return subtasks;
  } catch {
    return null;
  }
}
