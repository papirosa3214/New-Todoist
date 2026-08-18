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
//
// source — 18.08.2026, следующая просьба: «а как понять, что реально
// работает через Apple Intelligence» (выключать Wi-Fi ради проверки —
// плохой тест, ломает вообще всё приложение целиком, не только эту
// фичу — все данные и так идут через сервер). Возвращаем источник явно,
// TaskFormScreen показывает его короткой подписью рядом с результатом.
interface TranscribeResponse {
  text: string;
}

export function useTranscribeAudio() {
  return useMutation({
    mutationFn: async (
      blob: Blob,
    ): Promise<
      TranscribeResponse & {
        source: "whisper" | "apple" | "server";
        whisperReason?: string;
      }
    > => {
      const onDevice = await transcribeOnDevice(blob);
      // Три значения, а не два: на устройстве работают ДВА разных движка, и
      // «на устройстве» их не различало — см. комментарий у OnDeviceEngine.
      if (onDevice !== null) {
        return {
          text: onDevice.text,
          source: onDevice.engine,
          whisperReason: onDevice.whisperReason,
        };
      }
      const server = await api.postBlob<TranscribeResponse>(
        "/api/audio/transcribe",
        blob,
      );
      return { ...server, source: "server" };
    },
  });
}
