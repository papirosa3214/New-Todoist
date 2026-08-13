import { useMutation } from "@tanstack/react-query";
import { api } from "./client";

// Кнопка микрофона (TaskFormScreen) — запись из MediaRecorder отправляется
// как есть (Blob), сервер проксирует её на свой ASR-сервис (см.
// server/src/routes/transcribe.ts). Ничего не сохраняет сама по себе —
// вызывающий код решает, что делать с распознанным текстом.
interface TranscribeResponse {
  text: string;
}

export function useTranscribeAudio() {
  return useMutation({
    mutationFn: (blob: Blob) =>
      api.postBlob<TranscribeResponse>("/api/audio/transcribe", blob),
  });
}
