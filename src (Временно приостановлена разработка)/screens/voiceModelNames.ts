// Человеческие названия голосовых моделей для интерфейса.
//
// Вынесено из VoiceModelsScreen отдельным модулем ради теста: правило
// «на экране не должно быть технических имён» проверяется в
// voiceModelNames.test.ts, а тащить в тест весь экран с роутером и
// нативными плагинами незачем.

// В интерфейсе — только человеческие названия. Владелец 26.08.2026, увидев
// «large-v3-v20240930» подписью под «Точная»: «я ж тебе сказал, по-человечески
// чтобы было написано». Техническое имя нужно коду (по нему качают и
// выбирают), но не глазам: на экране остаётся роль и размер.
export function humanName(model: string): string {
  if (model.includes("distil")) return "Быстрая";
  if (model.includes("large-v3-v20240930")) return "Точная";
  if (model.includes("large")) return "Большая";
  if (model.includes("medium")) return "Средняя";
  if (model.includes("small")) return "Небольшая";
  if (model.includes("base")) return "Лёгкая";
  if (model.includes("tiny")) return "Самая лёгкая";
  return model.replace(/^openai_whisper-/, "").replace(/_\d+MB$/, "");
}
