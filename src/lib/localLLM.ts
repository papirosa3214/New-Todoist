// Языковая модель НА УСТРОЙСТВЕ — мост к ios/App/App/LocalLLMPlugin.swift.
//
// Отдельно от localAI.ts намеренно: там движки Apple (Whisper через CoreML и
// FoundationModels), здесь — MLX со скачиваемой моделью. Причина появления:
// Apple Intelligence в России недоступен вообще, а расшифровывать действия
// агента владелец хочет на телефоне, а не на сервере (25.08.2026: «из
// телефона эта модель все и расшифровывает, не с сервера»).
//
// На вебе плагина физически нет — все функции ниже обязаны молча возвращать
// «недоступно», а вызывающий код продолжать работать без них: строка
// активности осмысленна и без модели (слои 1-2 на сервере).
import { registerPlugin, Capacitor } from "@capacitor/core";

export interface LocalLLMStatus {
  model: string;
  /** Веса лежат на диске — можно пользоваться офлайн. */
  downloaded: boolean;
  /** Веса загружены в память — первая фраза уже не будет ждать загрузки. */
  ready: boolean;
  loading: boolean;
}

interface TFLocalLLMPlugin {
  isAvailable(): Promise<{ available: boolean; model?: string; reason?: string }>;
  status(): Promise<LocalLLMStatus>;
  download(): Promise<{ downloaded: boolean; ready: boolean }>;
  deleteModel(): Promise<{ downloaded: boolean }>;
  explain(opts: { action: string; step?: string }): Promise<{ text: string }>;
  addListener(
    event: "llmProgress",
    cb: (data: { progress: number }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

const TFLocalLLM = registerPlugin<TFLocalLLMPlugin>("TFLocalLLM");

/** Дешёвая проверка ДО похода в мост: MLX — это Metal, на вебе его нет. */
export function localLLMSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

const OFFLINE: LocalLLMStatus = {
  model: "",
  downloaded: false,
  ready: false,
  loading: false,
};

export async function localLLMStatus(): Promise<LocalLLMStatus> {
  if (!localLLMSupported()) return OFFLINE;
  try {
    return await TFLocalLLM.status();
  } catch {
    return OFFLINE;
  }
}

export async function downloadLocalLLM(): Promise<void> {
  await TFLocalLLM.download();
}

export async function deleteLocalLLM(): Promise<void> {
  await TFLocalLLM.deleteModel();
}

export function onLocalLLMProgress(
  cb: (data: { progress: number }) => void,
): Promise<() => void> {
  if (!localLLMSupported()) return Promise.resolve(() => {});
  return TFLocalLLM.addListener("llmProgress", cb).then((h) => () => {
    void h.remove();
  });
}

/**
 * Одна фраза «что делает агент» по техническому действию.
 *
 * Возвращает null, если модель не скачана, не поддерживается или ответила
 * ошибкой — это НЕ повод показывать пустоту: у вызывающего есть строка от
 * сервера (слои 1-2), она и остаётся. Ошибку намеренно глушим: расшифровка
 * — украшение, из-за неё карточка ломаться не должна.
 */
export async function explainAction(
  action: string,
  step?: string,
): Promise<string | null> {
  if (!localLLMSupported()) return null;
  try {
    const { text } = await TFLocalLLM.explain({ action, step });
    const clean = (text || "").trim();
    return clean.length > 0 ? clean : null;
  } catch {
    return null;
  }
}
