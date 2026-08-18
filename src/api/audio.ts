import { useMutation } from "@tanstack/react-query";
import { api } from "./client";
import { transcribeOnDevice } from "../lib/localAI";

// Кнопка микрофона (TaskFormScreen) — запись из MediaRecorder отправляется
// как есть (Blob), сервер проксирует её на свой ASR-сервис (см.
// server/src/routes/transcribe.ts). Ничего не сохраняет сама по себе —
// вызывающий код решает, что делать с распознанным текстом.
//
// On-device первым (18.08.2026, «мне задержка не нравится очень долгая») —
// transcribeOnDevice возвращает null и при недоступности (не iOS/нет
// on-device распознавания русского), и при сбое самого вызова — в обоих
// случаях просто падаем на сервер, тут этот выбор не различать.
interface TranscribeResponse {
  text: string;
}

export function useTranscribeAudio() {
  return useMutation({
    mutationFn: async (blob: Blob) => {
      const onDevice = await transcribeOnDevice(blob);
      if (onDevice !== null) return { text: onDevice };
      return api.postBlob<TranscribeResponse>("/api/audio/transcribe", blob);
    },
  });
}
