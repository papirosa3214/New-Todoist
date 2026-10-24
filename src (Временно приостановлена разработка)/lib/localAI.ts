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

export interface ModelStatus {
  selected: string;
  installed: string[];
  ready: boolean;
  loadedModel: string;
  loading: boolean;
  downloading: string;
  progress: number;
  error: string;
  /** Сколько секунд идёт прогрев. 0 — не идёт. */
  loadingSeconds: number;
}

interface LocalAIPlugin {
  isAvailable(): Promise<{ llm: boolean; llmReason: string; asr: boolean }>;
  transcribe(opts: {
    audioBase64: string;
    mimeType?: string;
  }): Promise<{ text: string; engine?: string; whisperReason?: string }>;
  suggestSubtasks(opts: { text: string }): Promise<{ subtasks: string[] }>;
  listModels(): Promise<ModelStatus & { available: string[] }>;
  modelStatus(): Promise<ModelStatus>;
  downloadModel(opts: { model: string }): Promise<ModelStatus>;
  selectModel(opts: { model: string }): Promise<ModelStatus>;
  deleteModel(opts: { model: string }): Promise<ModelStatus>;
  prepareModel(): Promise<ModelStatus>;
  addListener(
    event: "whisperProgress",
    cb: (data: { model: string; progress: number }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
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

/** Движок, которым реально распознали. Нужен, чтобы «на устройстве» не
    сваливало в одну подпись два разных механизма: Whisper (скачанная модель,
    качество выше) и системную диктовку Apple (та же, что под микрофоном
    клавиатуры). Владелец 18.08.2026: «действует по модели это или же опять
    обычная диктовка» — по прежней подписи различить было нельзя. */
export type OnDeviceEngine = "whisper" | "apple";

export async function transcribeOnDevice(
  blob: Blob,
): Promise<{
  text: string;
  engine: OnDeviceEngine;
  /** Почему не Whisper — только когда engine === "apple". */
  whisperReason?: string;
} | null> {
  try {
    const { asr } = await checkLocalAIAvailability();
    if (!asr) return null;
    const audioBase64 = await blobToBase64(blob);
    // MIME передаём явно: AVFoundation определяет контейнер по расширению
    // временного файла, а угаданное расширение давало
    // kAudioFileUnsupportedFileTypeError.
    const { text, engine, whisperReason } = await LocalAI.transcribe({
      audioBase64,
      mimeType: blob.type,
    });
    // Плагин отдаёт "whisper" или "apple". Незнакомое значение трактуем как
    // apple: молча соврать «работает модель» хуже, чем недооценить.
    return {
      text,
      engine: engine === "whisper" ? "whisper" : "apple",
      whisperReason,
    };
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

// ═══════════ Управление моделями распознавания из настроек ═══════════
//
// Всё это доступно только на нативном iOS. На вебе экран моделей просто
// показывает, что управлять нечем — бросать исключение в UI незачем.

export function localAIModelsSupported(): boolean {
  return isNativeIOS();
}

export async function listWhisperModels(): Promise<
  (ModelStatus & { available: string[] }) | null
> {
  if (!isNativeIOS()) return null;
  return LocalAI.listModels();
}

export async function downloadWhisperModel(model: string): Promise<ModelStatus> {
  return LocalAI.downloadModel({ model });
}

export async function selectWhisperModel(model: string): Promise<ModelStatus> {
  return LocalAI.selectModel({ model });
}

export async function deleteWhisperModel(model: string): Promise<ModelStatus> {
  return LocalAI.deleteModel({ model });
}

export async function onWhisperProgress(
  cb: (data: { model: string; progress: number }) => void,
): Promise<() => void> {
  if (!isNativeIOS()) return () => {};
  const handle = await LocalAI.addListener("whisperProgress", cb);
  return () => {
    void handle.remove();
  };
}

/** Прогрев модели заранее. Без этого она начинала грузиться только в момент
    диктовки, а ждём мы её 3 секунды — CoreML-модель за это время не
    поднимается, и каждый раз уходило на диктовку Apple (18.08.2026: «почему
    отражается, что скачано и выбрано», а работал не Whisper). Fire-and-forget:
    ответ не нужен, важно лишь начать. */
/** То же, но с ответом: нужно, чтобы после скачивания и после выбора модели
    прогрев запускался СРАЗУ, а не «при следующем входе в приложение» — именно
    это состояние раздражало владельца в настройках (18.08.2026). */
export async function prepareWhisperModel(): Promise<ModelStatus | null> {
  if (!isNativeIOS()) return null;
  return LocalAI.prepareModel();
}

export function warmUpWhisper(): void {
  if (!isNativeIOS()) return;
  void LocalAI.prepareModel().catch(() => {
    // Молча: прогрев — оптимизация, его провал не должен ничего ломать, а
    // реальную причину покажет подпись после диктовки.
  });
}
