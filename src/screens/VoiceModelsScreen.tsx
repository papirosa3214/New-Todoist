import { useNavigate } from "react-router-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { FieldGroup, ScreenHeader, BackButton, ErrorBanner } from "../components/UI";
import {
  type ModelStatus,
  listWhisperModels,
  downloadWhisperModel,
  selectWhisperModel,
  deleteWhisperModel,
  onWhisperProgress,
  localAIModelsSupported,
  prepareWhisperModel,
} from "../lib/localAI";
import { getErrorMessage } from "../lib/errors";
import {
  type DictationLogEntry,
  clearDictationLog,
  isDictationLogEnabled,
  readDictationLog,
  setDictationLogEnabled,
  subscribeDictationLog,
} from "../lib/dictationLog";
import {
  flushArchiveQueue,
  pendingCount,
  subscribeArchiveQueue,
} from "../lib/dictationArchive";

// Экран управления локальными моделями распознавания речи (Максим,
// 18.08.2026: «я должен всё в настройках контролировать» — менять модель
// без обращения к разработчику и без пересборки приложения).
//
// Модели живут в контейнере приложения (песочница iOS), поэтому список
// «установлено» строится нативной стороной по факту наличия папки на
// диске, а не по флагу в настройках — флаг рассинхронизируется при любом
// прерванном скачивании.

// Размер НЕ хардкодим: в репозитории argmaxinc/whisperkit-coreml он зашит
// в имя варианта (`..._632MB`), а вариантов там вдвое больше, чем можно
// перечислить руками — любой ручной список сразу расходится с реальным.
function sizeLabel(model: string): string {
  const m = model.match(/_(\d+)MB$/);
  if (m) {
    const mb = Number(m[1]);
    return mb >= 1024 ? `~${(mb / 1024).toFixed(1)} ГБ` : `~${mb} МБ`;
  }
  // Без суффикса — полноразмерный float-вариант, он всегда крупнее
  // квантованных того же семейства.
  return "полный размер";
}

// Подсказка по семейству, а не по конкретному варианту — семейств мало и
// они стабильны.
function qualityLabel(model: string): string {
  if (model.includes("distil")) return "быстрая, качество чуть ниже large";
  if (model.includes("large-v3-v20240930")) return "рекомендуется: точность large, высокая скорость";
  if (model.includes("large")) return "максимум качества, медленнее";
  if (model.includes("medium")) return "точная, медленнее";
  if (model.includes("small")) return "баланс";
  if (model.includes("base")) return "быстрая, качество среднее";
  if (model.includes("tiny")) return "самая быстрая, качество низкое";
  return "";
}

// Модели с суффиксом .en — только английский, для русского бесполезны.
function isEnglishOnly(model: string): boolean {
  return /\.en(_|$)/.test(model);
}

// Из имени убираем и префикс репозитория, и суффикс размера: размер уже
// показан отдельной подписью снизу, а в названии он только мешал читать
// (Максим 18.08.2026: «удали в приложении числа и мегабайты»).
function prettyName(model: string): string {
  return model.replace(/^openai_whisper-/, "").replace(/_\d+MB$/, "");
}

// Один и тот же вес есть в двух видах: полный float и квантованный
// (`_632MB`). После срезания суффикса они выглядели бы одинаково — две
// неразличимые строки в списке. Оставляем по одной на семейство, и это
// квантованный вариант: он в 2-3 раза меньше при том же качестве.
function dedupeVariants(models: string[]): string[] {
  const byBase = new Map<string, string>();
  for (const model of models) {
    const base = model.replace(/_\d+MB$/, "");
    const existing = byBase.get(base);
    const isQuantized = /_\d+MB$/.test(model);
    if (!existing || isQuantized) byBase.set(base, model);
  }
  return [...byBase.values()];
}

export function VoiceModelsScreen() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<(ModelStatus & { available: string[] }) | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ model: string; progress: number } | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await listWhisperModels();
      if (mounted.current) setStatus(next);
    } catch (e) {
      if (mounted.current) setError(e);
    }
  }, []);

  // Пока модель прогревается, статус надо перечитывать: иначе индикатор
  // застынет на жёлтом и секунды не будут расти.
  useEffect(() => {
    if (!status?.loading) return;
    const t = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(t);
  }, [status?.loading, refresh]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // Прогресс приходит событием из нативной части: скачивание идёт
    // минуты, ждать промис молча нельзя.
    let off: (() => void) | undefined;
    void onWhisperProgress((data) => {
      if (mounted.current) setProgress(data);
    }).then((fn) => {
      off = fn;
    });
    return () => {
      mounted.current = false;
      off?.();
    };
  }, [refresh]);

  const run = async (model: string, action: () => Promise<ModelStatus>) => {
    setError(null);
    setBusy(model);
    try {
      await action();
      // Прогрев сразу после скачивания или выбора: раньше он начинался только
      // при следующем входе в приложение, и статус всё это время висел
      // «скачана, прогреется при входе» — бесполезное состояние.
      void prepareWhisperModel();
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      if (mounted.current) {
        setBusy(null);
        setProgress(null);
      }
    }
  };

  if (!localAIModelsSupported()) {
    return (
      <div>
        <ScreenHeader leading={<BackButton onClick={() => navigate(-1)} />} title="Модели распознавания" />
        <div className="px-4 text-[15px] text-sub">
          Локальные модели доступны только в приложении на iPhone. В браузере
          распознавание всегда идёт через сервер.
        </div>
      </div>
    );
  }

  const installed = new Set(status?.installed ?? []);
  // .en-варианты отфильтрованы: они только английские, а диктовка тут
  // русская — показывать их значит предлагать заведомо нерабочее.
  const available = dedupeVariants(
    (status?.available ?? []).filter((m) => !isEnglishOnly(m)),
  );

  return (
    <div>
      <ScreenHeader
        leading={<BackButton onClick={() => navigate(-1)} />}
        title="Модели распознавания"
      />

      <ErrorBanner error={error} fallback="Не удалось выполнить операцию" variant="block" />

      <div className="text-[13px] text-sub px-1 mb-2">
        Распознавание речи на самом телефоне, без интернета. Скачивание нужно
        один раз — дальше работает офлайн. Пока модель не выбрана или не
        загружена, используется встроенная диктовка Apple.
      </div>

      {status && (
        <div className="flex items-center gap-2 px-1 mb-3">
          {/* Цветом, а не только словами: владелец просил «зелёненьким —
              рабочее, жёлтеньким — прогревается, красненьким — вообще не
              фурычит» (18.08.2026). Порядок проверок: «не скачана» ВПЕРЕДИ
              «прогревается» — иначе после удаления модели статус продолжал
              показывать прогрев от прерванной загрузки, то есть врал про
              модель, которой уже нет на диске. */}
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
              status.error || !installed.has(status.selected)
                ? "bg-red"
                : status.ready
                  ? "bg-green"
                  : "bg-yellow"
            }`}
          />
          <div className="text-[13px] text-sub min-w-0">
            <span className="text-text">{prettyName(status.selected)}</span>
            {" — "}
            {status.error
              ? `не работает: ${status.error}`
              : !installed.has(status.selected)
                ? "не скачана"
                : status.ready
                  ? "работает"
                  : status.loadingSeconds > 0
                    ? `прогревается, ${status.loadingSeconds} с`
                    : "прогревается"}
          </div>
        </div>
      )}

      <div className="mb-4">
        <FieldGroup>
          {available.map((model) => {
            const isInstalled = installed.has(model);
            const isSelected = status?.selected === model;
            const isBusy = busy === model;
            const showProgress = progress?.model === model && isBusy;
            return (
              <div key={model} className="px-4 py-3 bg-card">
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[15px] text-text truncate">
                      {prettyName(model)}
                      {isSelected && <span className="text-sub text-[13px]"> · выбрана</span>}
                    </div>
                    <div className="text-[13px] text-sub truncate">
                      {sizeLabel(model)}
                      {qualityLabel(model) ? ` · ${qualityLabel(model)}` : ""}
                    </div>
                  </div>

                  {!isInstalled ? (
                    <button
                      disabled={isBusy}
                      onClick={() => void run(model, () => downloadWhisperModel(model))}
                      className="text-[14px] px-3 py-1 rounded-lg bg-blue/15 text-blue disabled:opacity-50"
                    >
                      {isBusy ? "Скачиваю из сети…" : "Скачать"}
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      {!isSelected && (
                        <button
                          disabled={isBusy}
                          onClick={() => void run(model, () => selectWhisperModel(model))}
                          className="text-[14px] px-3 py-1 rounded-lg bg-blue/15 text-blue disabled:opacity-50"
                        >
                          Выбрать
                        </button>
                      )}
                      <button
                        disabled={isBusy}
                        onClick={() => void run(model, () => deleteWhisperModel(model))}
                        className="text-[14px] px-3 py-1 rounded-lg text-coral disabled:opacity-50"
                      >
                        Удалить
                      </button>
                    </div>
                  )}
                </div>

                {showProgress && (
                  <div className="mt-2">
                    <div className="h-1.5 rounded-full bg-stroke overflow-hidden">
                      <div
                        className="h-full bg-blue transition-all"
                        style={{ width: `${Math.round((progress?.progress ?? 0) * 100)}%` }}
                      />
                    </div>
                    <div className="text-[12px] text-sub mt-1">
                      {Math.round((progress?.progress ?? 0) * 100)}%
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </FieldGroup>
      </div>

      <DictationLogSection />

      {available.length === 0 && (
        <div className="text-[13px] text-sub px-1">
          Список моделей не загрузился — нужен интернет, чтобы его получить.
          Уже скачанные модели продолжают работать офлайн.
          {error ? ` (${getErrorMessage(error, "")})` : ""}
        </div>
      )}
    </div>
  );
}

// ═══ Журнал диктовок ═══
// Отдельным компонентом: у него своя подписка и своё состояние, и экрану
// моделей незачем перерисовываться на каждую запись в журнале.
function DictationLogSection() {
  const [enabled, setEnabled] = useState(isDictationLogEnabled());
  const [entries, setEntries] = useState<DictationLogEntry[]>(readDictationLog());
  const [queued, setQueued] = useState(0);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const sync = () => {
      setEnabled(isDictationLogEnabled());
      setEntries(readDictationLog());
    };
    return subscribeDictationLog(sync);
  }, []);

  // Очередь аудио — своя подписка: она меняется и без записей в журнал (журнал
  // можно выключить, а архив продолжает работать).
  useEffect(() => {
    const sync = () => void pendingCount().then(setQueued);
    sync();
    return subscribeArchiveQueue(sync);
  }, []);

  return (
    <div className="mb-6">
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">
        Диагностика диктовки
      </div>
      {/* Архив аудио. Показываем всегда, а не только при включённом журнале:
          выгрузка идёт независимо от журнала, и владельцу нужно видеть, что
          записи не потерялись, пока сервер не обновлён. */}
      <div className="mb-2">
        <FieldGroup>
          <div className="flex items-center justify-between px-4 py-3 bg-card">
            <div className="text-[15px] text-text pr-3">
              Архив аудио на сервере
              <div className="text-[13px] text-sub">
                {queued === 0
                  ? "Всё выгружено"
                  : `Ждут отправки: ${queued}. Уйдут, когда .110 будет доступен`}
              </div>
            </div>
            {queued > 0 && (
              <button
                type="button"
                disabled={sending}
                onClick={() => {
                  setSending(true);
                  void flushArchiveQueue().finally(() => setSending(false));
                }}
                className="text-[14px] px-3 py-1 rounded-lg bg-blue/15 text-blue disabled:opacity-50 shrink-0"
              >
                {sending ? "Отправляю…" : "Отправить"}
              </button>
            )}
          </div>
        </FieldGroup>
      </div>

      <div className="mb-2">
        <FieldGroup>
          <div className="flex items-center justify-between px-4 py-3 bg-card">
            <div className="text-[15px] text-text pr-3">
              Записывать, что распознала модель
              <div className="text-[13px] text-sub">
                Видно текст от модели и текст после исправлений
              </div>
            </div>
            <button
              type="button"
              onClick={() => setDictationLogEnabled(!enabled)}
              className={`text-[14px] px-3 py-1 rounded-lg shrink-0 ${
                enabled ? "bg-green/20 text-green" : "bg-blue/15 text-blue"
              }`}
            >
              {enabled ? "Включено" : "Выключено"}
            </button>
          </div>
        </FieldGroup>
      </div>

      {enabled && entries.length === 0 && (
        <div className="text-[13px] text-sub px-1">
          Пока пусто — продиктуй что-нибудь, и запись появится здесь.
        </div>
      )}

      {entries.length > 0 && (
        <>
          <FieldGroup>
            {entries.map((entry) => (
              <div key={entry.at} className="px-4 py-3 bg-card">
                <div className="text-[12px] text-dim mb-1">
                  {new Date(entry.at).toLocaleTimeString("ru-RU")} · {entry.engine}
                  {entry.raw === entry.normalized
                    ? " · исправлений не потребовалось"
                    : " · исправлено нами"}
                </div>
                <div className="text-[13px] text-sub break-words">
                  от модели: {entry.raw || "—"}
                </div>
                {entry.raw !== entry.normalized && (
                  <div className="text-[13px] text-text break-words">
                    после правок: {entry.normalized}
                  </div>
                )}
              </div>
            ))}
          </FieldGroup>
          <button
            type="button"
            onClick={clearDictationLog}
            className="text-[14px] text-coral px-1 mt-2"
          >
            Очистить журнал
          </button>
        </>
      )}
    </div>
  );
}
