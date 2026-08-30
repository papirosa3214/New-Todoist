
import { useCallback, useEffect, useRef, useState } from "react";
import { FieldGroup, ScreenHeader, ErrorBanner, Icon } from "../components/UI";
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
import { humanName } from "./voiceModelNames";
import {
  type DictationLogEntry,
  clearDictationLog,
  isDictationLogEnabled,
  readDictationLog,
  setDictationLogEnabled,
  subscribeDictationLog,
} from "../lib/dictationLog";
import {
  type LocalLLMStatus,
  localLLMSupported,
  localLLMStatus,
  downloadLocalLLM,
  deleteLocalLLM,
  onLocalLLMProgress,
} from "../lib/localLLM";
import { type ServerAIStatus, fetchServerAIStatus, serverModelName } from "../lib/aiStatus";
import { AiProviderModal } from "../components/AiProviderModal";
import { useAppStore, AI_PROVIDERS } from "../store";
import {
  flushArchiveQueue,
  pendingCount,
  subscribeArchiveQueue,
} from "../lib/dictationArchive";

// Раздел «Искусственный интеллект» — ВСЕ модели системы в одном месте.
//
// Владелец 26.08.2026: «все эти модели, все ИИшки в один раздел запихни. Не
// надо больших описательных вещей, это лишняя информация. Чётко: локальная
// модель на сервере — крупная, отвечающая за такие-то функции; голосовая
// модель такая-то; всё ярлычками, иконочками».
//
// Отсюда устройство экрана:
//   строка = одна СПОСОБНОСТЬ (распознавание речи, расшифровка действий,
//   серверный разбор), а не имя файла весов;
//   иконка слева — чтобы взгляд цеплялся за роль, а не читал текст;
//   справа — состояние и размер, одно значение, без предложений;
//   пояснение — ОДНА строка под названием, что эта модель делает в
//   приложении. Всё остальное убрано: техническое имя, версии, мегабайты в
//   названии, абзацы про офлайн.
//
// Модели живут в контейнере приложения (песочница iOS), поэтому «установлено»
// строится нативной стороной по факту наличия папки на диске, а не по флагу в
// настройках — флаг рассинхронизируется при любом прерванном скачивании.

// Размер НЕ хардкодим: в репозитории argmaxinc/whisperkit-coreml он зашит
// в имя варианта (`..._632MB`), а вариантов там вдвое больше, чем можно
// перечислить руками — любой ручной список сразу расходится с реальным.
function sizeLabel(model: string): string {
  const m = model.match(/_(\d+)MB$/);
  if (m) {
    const mb = Number(m[1]);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} ГБ` : `${mb} МБ`;
  }
  return "";
}

// Модели с суффиксом .en — только английский, для русского бесполезны.
function isEnglishOnly(model: string): boolean {
  return /\.en(_|$)/.test(model);
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

// Наверх — ровно две: точная и быстрая. Ищем по семействам, а не по точным
// именам: имена в репозитории меняются (large-v3 -> large-v3-v20240930),
// захардкоженная строка молча перестала бы находиться.
function pickRecommended(models: string[]): {
  accurate: string | null;
  fast: string | null;
} {
  const find = (test: (m: string) => boolean) => models.find(test) ?? null;
  const accurate =
    find((m) => m.includes("large-v3-v20240930")) ??
    find((m) => m.includes("large-v3")) ??
    find((m) => m.includes("large"));
  const fast =
    find((m) => m.includes("distil")) ??
    find((m) => m.includes("base")) ??
    find((m) => m.includes("small"));
  return { accurate, fast: fast === accurate ? null : fast };
}

type Dot = "ok" | "warn" | "off";

/** Цветная точка состояния — владелец 18.08.2026: «зелёненьким — рабочее,
    жёлтеньким — прогревается, красненьким — вообще не фурычит». */
function StatusDot({ state }: { state: Dot }) {
  const color = state === "ok" ? "bg-green" : state === "warn" ? "bg-yellow" : "bg-dim/50";
  return <span className={`w-2 h-2 rounded-full shrink-0 ${color}`} />;
}

/**
 * Строка раздела: иконка — роль — состояние — действие.
 *
 * Одна разметка на все модели, чтобы раздел читался единым списком, а не
 * тремя разными блоками.
 */
function ModelRow({
  icon,
  title,
  subtitle,
  value,
  dot,
  action,
  onClick,
  progress,
}: {
  icon: string;
  title: string;
  subtitle: string;
  value?: string;
  dot?: Dot;
  action?: React.ReactNode;
  onClick?: () => void;
  progress?: number | null;
}) {
  const body = (
    <div className="flex items-center gap-3 px-4 py-3">
      <Icon name={icon} size={18} className="text-dim shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {dot && <StatusDot state={dot} />}
          <span className="text-[15px] text-text truncate">{title}</span>
        </div>
        <div className="text-[13px] text-sub truncate">{subtitle}</div>
      </div>
      {value && <span className="text-[13px] text-dim shrink-0">{value}</span>}
      {action}
      {onClick && !action && (
        <Icon name="chevron" size={16} className="text-dim shrink-0" />
      )}
    </div>
  );

  return (
    <div className="bg-card">
      {onClick ? (
        <button type="button" onClick={onClick} className="tap-fade w-full text-left">
          {body}
        </button>
      ) : (
        body
      )}
      {progress != null && (
        <div className="px-4 pb-3">
          <div className="h-1.5 rounded-full bg-stroke overflow-hidden">
            <div
              className="h-full bg-blue transition-all"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] uppercase tracking-wide text-dim px-1 mb-2 mt-4">
      {children}
    </div>
  );
}

export function VoiceModelsScreen() {
  const [status, setStatus] = useState<(ModelStatus & { available: string[] }) | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ model: string; progress: number } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [llmOpen, setLlmOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [llm, setLlm] = useState<LocalLLMStatus | null>(null);
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmProgress, setLlmProgress] = useState<number | null>(null);
  const [server, setServer] = useState<ServerAIStatus | null>(null);
  const [brainOpen, setBrainOpen] = useState(false);
  const aiProvider = useAppStore((s) => s.aiProvider);
  const localOllamaModel = useAppStore((s) => s.localOllamaModel);
  const brainInfo = AI_PROVIDERS[aiProvider] || AI_PROVIDERS.local;
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await listWhisperModels();
      if (mounted.current) setStatus(next);
    } catch (e) {
      if (mounted.current) setError(e);
    }
    if (mounted.current) setLlm(await localLLMStatus());
    const s = await fetchServerAIStatus();
    if (mounted.current) setServer(s);
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
    // Прогресс приходит событием из нативной части: скачивание идёт минуты,
    // ждать промис молча нельзя.
    let offWhisper: (() => void) | undefined;
    let offLlm: (() => void) | undefined;
    void onWhisperProgress((data) => {
      if (mounted.current) setProgress(data);
    }).then((fn) => {
      offWhisper = fn;
    });
    void onLocalLLMProgress(({ progress }) => {
      if (mounted.current) setLlmProgress(progress);
    }).then((fn) => {
      offLlm = fn;
    });
    return () => {
      mounted.current = false;
      offWhisper?.();
      offLlm?.();
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

  const runLlm = async (action: () => Promise<void>) => {
    setError(null);
    setLlmBusy(true);
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      if (mounted.current) {
        setLlmBusy(false);
        setLlmProgress(null);
      }
    }
  };

  if (!localAIModelsSupported()) {
    return (
      <div>
        <ScreenHeader
          title="Искусственный интеллект"
        />
        <div className="px-4 text-[15px] text-sub">
          Модели на устройстве доступны только в приложении на iPhone. В
          браузере всё идёт через сервер.
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
  const { accurate, fast } = pickRecommended(available);

  const selected = status?.selected ?? "";
  const voiceReady = !!status && installed.has(selected) && status.ready;

  // ═══ ЕДИНЫЙ ЯЗЫК РАЗДЕЛА (Максим 26.08.2026: «в одном меню три разных
  // набора» — статусы и действия у всех строк должны совпадать) ═══
  // Правая колонка — всегда ОДНО слово из общего словаря:
  //   работает / прогревается / скачивается / не скачана / нет связи /
  //   не найдена. Точка: зелёная — работает, жёлтая — занята (прогрев,
  //   скачивание), серая — недоступна. Кнопок в верхних строках нет
  //   вообще: тап раскрывает список, действия (Скачать/Выбрать/Удалить)
  //   — только там, у всех моделей одинаковые.
  const voiceDot: Dot = status?.error || !installed.has(selected)
    ? "off"
    : voiceReady
      ? "ok"
      : "warn";
  const voiceValue = !status
    ? "…"
    : !installed.has(selected)
      ? "не скачана"
      : voiceReady
        ? "работает"
        : "прогревается";

  const llmValue = !llm
    ? "…"
    : llmBusy
      ? "скачивается"
      : !llm.downloaded
        ? "не скачана"
        : llm.loading
          ? "прогревается"
          : "работает";
  const llmDot: Dot = !llm || !llm.downloaded
    ? "off"
    : llmBusy || llm.loading
      ? "warn"
      : "ok";

  // Выбор показываем всегда: скачанные и выбранная не должны прятаться, даже
  // если не входят в рекомендованную пару — гигабайт на диске нельзя скрывать.
  const pinned = [accurate, fast, selected]
    .concat([...installed])
    .filter((m): m is string => !!m && available.includes(m));
  const primary = [...new Set(pinned)];
  const rest = available.filter((m) => !primary.includes(m));
  const shown = showAll ? [...primary, ...rest] : primary;

  return (
    <div>
      <ScreenHeader
        title="Искусственный интеллект"
      />

      <ErrorBanner error={error} fallback="Не удалось выполнить операцию" variant="block" />

      <SectionTitle>На телефоне</SectionTitle>
      <FieldGroup>
        <ModelRow
          icon="mic"
          title="Распознавание речи"
          subtitle={
            installed.has(selected)
              ? `${humanName(selected)} · диктовка задач и заметок`
              : "Диктовка задач, заметок и комментариев"
          }
          value={voiceValue}
          dot={voiceDot}
          onClick={() => setPickerOpen((v) => !v)}
        />
        <ModelRow
          icon="sparkles"
          title="Расшифровка действий"
          subtitle="Объясняет, чем занят агент в задаче"
          value={llmValue}
          dot={llmDot}
          progress={llmBusy ? (llmProgress ?? 0) : null}
          onClick={localLLMSupported() ? () => setLlmOpen((v) => !v) : undefined}
        />
      </FieldGroup>

      {/* Раскрытие «Расшифровки действий» — та же механика и те же кнопки,
          что у голосовых моделей ниже: строка модели, размер, Скачать или
          Удалить. Один язык на весь раздел. */}
      {llmOpen && localLLMSupported() && (
        <div className="mt-2">
          <FieldGroup>
            <ModelRow
              icon={llm?.downloaded ? "check" : "sparkles"}
              title="Qwen Coder 3B"
              subtitle={llm?.downloaded ? "используется" : "не скачана"}
              value="1.8 ГБ"
              progress={llmBusy ? (llmProgress ?? 0) : null}
              action={
                llm?.downloaded ? (
                  <button
                    disabled={llmBusy}
                    onClick={() => void runLlm(deleteLocalLLM)}
                    className="text-[14px] px-3 py-1 rounded-lg text-coral disabled:opacity-50"
                  >
                    Удалить
                  </button>
                ) : (
                  <button
                    disabled={llmBusy}
                    onClick={() => void runLlm(downloadLocalLLM)}
                    className="text-[14px] px-3 py-1 rounded-lg bg-blue/15 text-blue disabled:opacity-50"
                  >
                    {llmBusy ? "Качаю…" : "Скачать"}
                  </button>
                )
              }
            />
          </FieldGroup>
        </div>
      )}

      {/* Выбор голосовой модели раскрывается по строке — в свёрнутом виде
          раздел остаётся коротким, а список вариантов нужен редко. */}
      {pickerOpen && (
        <div className="mt-2">
          <FieldGroup>
            {shown.map((model) => {
              const isInstalled = installed.has(model);
              const isSelected = selected === model;
              const isBusy = busy === model;
              return (
                <ModelRow
                  key={model}
                  icon={isSelected ? "check" : "mic"}
                  title={humanName(model)}
                  subtitle={isInstalled ? (isSelected ? "используется" : "скачана") : "не скачана"}
                  value={sizeLabel(model)}
                  progress={progress?.model === model && isBusy ? progress.progress : null}
                  action={
                    !isInstalled ? (
                      <button
                        disabled={isBusy}
                        onClick={() => void run(model, () => downloadWhisperModel(model))}
                        className="text-[14px] px-3 py-1 rounded-lg bg-blue/15 text-blue disabled:opacity-50"
                      >
                        {isBusy ? "Качаю…" : "Скачать"}
                      </button>
                    ) : isSelected ? undefined : (
                      <div className="flex items-center gap-2">
                        <button
                          disabled={isBusy}
                          onClick={() => void run(model, () => selectWhisperModel(model))}
                          className="text-[14px] px-3 py-1 rounded-lg bg-blue/15 text-blue disabled:opacity-50"
                        >
                          Выбрать
                        </button>
                        <button
                          disabled={isBusy}
                          onClick={() => void run(model, () => deleteWhisperModel(model))}
                          className="text-[14px] px-3 py-1 rounded-lg text-coral disabled:opacity-50"
                        >
                          Удалить
                        </button>
                      </div>
                    )
                  }
                />
              );
            })}
          </FieldGroup>
          {rest.length > 0 && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="tap-fade w-full text-[14px] text-blue py-3 text-center"
            >
              {showAll ? "Свернуть" : `Ещё ${rest.length}`}
            </button>
          )}
        </div>
      )}

      <SectionTitle>На сервере</SectionTitle>
      <FieldGroup>
        {/* «Мозг» — выбор провайдера для разбора задач (бывший «Основной AI
            Мозг» из корня настроек, перенесён сюда 26.08.2026: весь ИИ в
            одном разделе). Тот же словарь и та же механика: слово справа,
            тап открывает выбор. */}
        <ModelRow
          icon="bot"
          title="Мозг для задач"
          subtitle={
            aiProvider === "local"
              ? `${serverModelName(localOllamaModel)} · разбивка задач на шаги`
              : `${brainInfo.name} · разбивка задач на шаги`
          }
          value={!server ? "…" : server.online || aiProvider !== "local" ? "работает" : "нет связи"}
          dot={!server ? "off" : server.online || aiProvider !== "local" ? "ok" : "off"}
          onClick={() => setBrainOpen(true)}
        />
        <ModelRow
          icon="cloud"
          title={server ? serverModelName(server.model) : "Серверная модель"}
          subtitle="Разбор диктовки, сводки и AI-действия в Дневнике"
          value={
            !server ? "…" : !server.online ? "нет связи" : server.installed === false ? "не найдена" : "работает"
          }
          dot={!server || !server.online ? "off" : server.installed === false ? "warn" : "ok"}
        />
      </FieldGroup>

      <AiProviderModal isOpen={brainOpen} onClose={() => setBrainOpen(false)} />

      {available.length === 0 && (
        <div className="text-[13px] text-sub px-1 mt-3">
          Список моделей не загрузился — нужен интернет, чтобы его получить.
          Уже скачанные работают офлайн.
          {error ? ` (${getErrorMessage(error, "")})` : ""}
        </div>
      )}

      <DictationLogSection />
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
                  {new Date(entry.at).toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow" })} · {entry.engine}
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
