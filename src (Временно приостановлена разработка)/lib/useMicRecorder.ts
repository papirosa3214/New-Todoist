import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";

function isNativeIOS(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

// ═══════════ Запись голоса в браузере — кнопка микрофона ═══════════
//
// getUserMedia/MediaRecorder работают ТОЛЬКО в secure context (HTTPS или
// localhost) — на обычном http://192.168.1.110:5180 браузер тихо
// отклоняет getUserMedia ещё до диалога разрешений. Это ограничение
// платформы, не баг этого хука; пока сервер не поднят по HTTPS, кнопка
// будет рабочей только при заходе через localhost на самой .110.
//
// Автостоп на 30 минут (Максим 26.08.2026: «для дневника поставь с полчаса,
// чтобы можно было запись вести» — длинные надиктовки дневниковых записей).
// Было 5 минут; защита от забытой записи остаётся, просто потолок честный
// под реальный сценарий. Размер файла при webm/opus ~0.5 МБ/мин — полчаса
// это ~15 МБ, сервер и ASR такое переваривают.
const MAX_DURATION_MS = 1_800_000;
// Сколько держать микрофон захваченным между записями, чтобы не спрашивать
// разрешение заново. Две минуты — запас на «надиктовал, подумал, надиктовал
// ещё»; дольше держать нельзя, иначе индикатор записи горит просто так.
const IDLE_RELEASE_MS = 120_000;

export type MicState = "idle" | "recording" | "processing";

export function useMicRecorder(onDone: (blob: Blob) => void) {
  const [state, setState] = useState<MicState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<unknown>(null);

  // Ref, не прямая зависимость useCallback — держит start() стабильной
  // между рендерами, при этом onstop всегда зовёт АКТУАЛЬНЫЙ колбэк, а не
  // тот, что был на момент нажатия кнопки записи.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Живой сигнал микрофона для кольца (MicRing) ──
  // Owner 2026-08-13: перенос готового виджета «voice-ring-2.html»
  // (прислан 1:1, не переизобретать) — параметры Web Audio узла ТОЧНО как
  // в присланном файле (fftSize=1024, а не что-то своё), чтобы совпадала
  // и плотность данных, на которой была откалибрована вся «органика»
  // кольца (BAR_PHASE/SPEED/BIAS, LERP-сглаживание — см. MicRing.tsx).
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  // <ArrayBuffer>, не голый Uint8Array — в свежих lib.dom типах тот
  // обобщён над ArrayBufferLike (включая SharedArrayBuffer), иначе
  // getByteTimeDomainData() ниже не типизируется (тот же паттерн, что в
  // api/audio.ts).
  const timeArrayRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  // ── Почему поток НЕ закрывается сразу после записи ──
  // Каждый вызов getUserMedia в приложении, запущенном с домашнего экрана
  // (standalone PWA), Safari может встречать новым запросом разрешения —
  // владелец 2026-08-14: «устал давать разрешение перед каждой записью».
  // Пока поток жив, нового запроса не требуется вовсе, поэтому между
  // записями он удерживается — но не бесконечно: через IDLE_RELEASE_MS
  // тишины отпускается совсем. Иначе индикатор захваченного микрофона
  // (оранжевая точка в iOS) горел бы всё время, пока открыто приложение —
  // а это ровно то, чего от трекера задач не ждут.
  const idleReleaseRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Отпустить микрофон совсем: треки, Web Audio, всё. */
  const releaseStream = useCallback(() => {
    if (idleReleaseRef.current) clearTimeout(idleReleaseRef.current);
    idleReleaseRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
    timeArrayRef.current = null;
  }, []);

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (autoStopRef.current) clearTimeout(autoStopRef.current);
    timerRef.current = null;
    autoStopRef.current = null;
    recorderRef.current = null;
    // Сам поток остаётся живым — его отпустит таймер простоя ниже, если
    // следующей записи так и не случится.
    if (idleReleaseRef.current) clearTimeout(idleReleaseRef.current);
    idleReleaseRef.current = setTimeout(releaseStream, IDLE_RELEASE_MS);
  }, [releaseStream]);

  // Читает актуальную форму сигнала прямо сейчас — вызывается из
  // requestAnimationFrame-цикла MicRing, не из React state (60
  // ре-рендеров/сек были бы лишними, рисование и так гоняет свой rAF).
  // Возвращает null, если Web Audio недоступен/ещё не готов — вызывающий
  // код молча деградирует (кольцо остаётся в покое), запись и
  // распознавание от Web Audio не зависят.
  const getTimeDomainData = useCallback((): Uint8Array<ArrayBuffer> | null => {
    const analyser = analyserRef.current;
    const data = timeArrayRef.current;
    if (!analyser || !data) return null;
    analyser.getByteTimeDomainData(data);
    return data;
  }, []);

  // Componente unmount (навигация с формы во время записи) — не оставлять
  // микрофон физически захваченным.
  // Уход с экрана — отпускаем микрофон сразу, не дожидаясь таймера простоя:
  // держать его захваченным, когда форма уже закрыта, нельзя.
  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (autoStopRef.current) clearTimeout(autoStopRef.current);
      recorderRef.current = null;
      releaseStream();
    },
    [releaseStream],
  );

  const start = useCallback(async () => {
    setError(null);
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setError("Запись голоса не поддерживается этим браузером.");
      return;
    }

    // Живой поток с прошлой записи переиспользуется — именно это и убирает
    // повторные запросы разрешения. Треки проверяются на "live": iOS может
    // оборвать их сам (звонок, переключение приложения), и молча писать в
    // мёртвый поток нельзя — тогда запрашиваем заново.
    const kept = streamRef.current;
    const keptAlive =
      kept && kept.getTracks().some((t) => t.readyState === "live");
    if (idleReleaseRef.current) {
      clearTimeout(idleReleaseRef.current);
      idleReleaseRef.current = null;
    }
    if (!keptAlive && kept) releaseStream();

    let stream: MediaStream;
    try {
      stream = keptAlive
        ? (kept as MediaStream)
        : await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: any) {
      // NotAllowedError (разрешение отклонено/заблокировано политикой) —
      // самый частый случай на практике; остальное (NotFoundError — нет
      // микрофона, и т.п.) через общий текст.
      setError(
        err?.name === "NotAllowedError"
          ? "Нет доступа к микрофону. Разрешите доступ в настройках браузера."
          : "Не удалось включить микрофон.",
      );
      return;
    }

    // Web Audio — параметры и порядок действий 1:1 из voice-ring-2.html
    // (audioCtx.resume() для suspended состояния включительно). Best-effort:
    // если не получилось — кольцо просто остаётся в покое, запись и
    // распознавание всё равно работают дальше как ни в чём не бывало.
    try {
      if (!audioCtxRef.current) {
        const AudioCtx =
          window.AudioContext || (window as any).webkitAudioContext;
        const audioCtx = new AudioCtx();
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        const src = audioCtx.createMediaStreamSource(stream);
        src.connect(analyser);
        audioCtxRef.current = audioCtx;
        analyserRef.current = analyser;
        timeArrayRef.current = new Uint8Array(
          new ArrayBuffer(analyser.fftSize),
        );
      }
      if (audioCtxRef.current.state === "suspended") {
        await audioCtxRef.current.resume();
      }
    } catch {
      // getTimeDomainData() будет молча возвращать null — обработано на
      // стороне отрисовки (MicRing).
    }

    // Chrome/большинство браузеров дают webm/opus; Safari — обычно mp4.
    // ASR-сервис определяет формат сам через ffmpeg, не по расширению —
    // достаточно взять первый реально поддерживаемый вариант.
    // Порядок зависит от платформы. На вебе webm/opus компактнее. На
    // нативном iOS он неприемлем: AVFoundation (и WhisperKit, и
    // DictationTranscriber) WebM не читает вообще, отдаёт
    // kAudioFileUnsupportedFileTypeError, и весь локальный путь молча
    // уходит на сервер. mp4/AAC читается. Серверному ASR формат безразличен
    // (ffmpeg определяет сам), так что приоритет mp4 на iOS ничего не ломает.
    const candidates = isNativeIOS()
      ? ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]
      : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    const mimeType = candidates.find((t) => MediaRecorder.isTypeSupported(t));

    const recorder = new MediaRecorder(
      stream,
      mimeType ? { mimeType } : undefined,
    );
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, {
        type: recorder.mimeType || mimeType || "audio/webm",
      });
      cleanup();
      setState("processing");
      onDoneRef.current(blob);
    };

    streamRef.current = stream;
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    recorder.start();
    setState("recording");

    timerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 200);
    autoStopRef.current = setTimeout(() => {
      recorderRef.current?.stop();
    }, MAX_DURATION_MS);
  }, [cleanup]);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  // После успешной/неуспешной отправки на сервер — сброс processing → idle.
  // Вызывающий код (TaskFormScreen) решает, когда это произошло.
  const finish = useCallback(() => setState("idle"), []);

  return {
    state,
    elapsedMs,
    error,
    setError,
    start,
    stop,
    finish,
    getTimeDomainData,
  };
}
