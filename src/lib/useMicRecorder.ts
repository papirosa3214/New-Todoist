import { useCallback, useEffect, useRef, useState } from "react";

// ═══════════ Запись голоса в браузере — кнопка микрофона ═══════════
//
// getUserMedia/MediaRecorder работают ТОЛЬКО в secure context (HTTPS или
// localhost) — на обычном http://192.168.1.110:5180 браузер тихо
// отклоняет getUserMedia ещё до диалога разрешений. Это ограничение
// платформы, не баг этого хука; пока сервер не поднят по HTTPS, кнопка
// будет рабочей только при заходе через localhost на самой .110.
//
// Автостоп на 60с — не даёт случайно заряженной записи вырасти в
// многоминутный файл (тело ASR-сервиса ограничено 25 МБ) и держит
// распознавание в разумных временных рамках на CPU-инференсе.
const MAX_DURATION_MS = 60_000;

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

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (autoStopRef.current) clearTimeout(autoStopRef.current);
    timerRef.current = null;
    autoStopRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  // Componente unmount (навигация с формы во время записи) — не оставлять
  // микрофон физически захваченным.
  useEffect(() => cleanup, [cleanup]);

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

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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

    // Chrome/большинство браузеров дают webm/opus; Safari — обычно mp4.
    // ASR-сервис определяет формат сам через ffmpeg, не по расширению —
    // достаточно взять первый реально поддерживаемый вариант.
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
      (t) => MediaRecorder.isTypeSupported(t),
    );

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
  };
}
