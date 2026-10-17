// Первый сценарий JEV (владелец 16.10.2026): какой состав команды предложить
// карточке. До этого в режиме `auto` профиль выбирался регулярными
// выражениями по словам названия («экран», «сервер», «исслед»), и «поправь
// текст экрана» уходило в полный цикл из семи ролей.
//
// JEV выбирает общие профили и специализированные UX/API/аудит-пакеты
// (proposalFor → `profile` в task-collaboration-plans.ts). Специфичные
// шаблоны (баг/регрессия, продуктовая фича) по-прежнему ловятся раньше —
// их JEV не перебивает. Выключен, не ответил, не уверен — null, и остаётся
// выбор по словам. План — черновик: утверждает его всё равно владелец.
import db from "../db.js";
import { evaluateJev, jevPlanProfileConfig } from "./jev.js";

export type JevPlanProfile =
  "single_executor" | "research" | "delivery" | "full_cycle" | "ux_concept" | "api_integration" | "audit";

export interface JevPlanProfilePick {
  profile: JevPlanProfile;
  confidence: number;
}

/** Описания — то, что JEV читает о каждом варианте. Писать по смыслу
 *  работы, а не по словам: именно это и отличает его от регулярок. */
const CRITERIA: Record<JevPlanProfile, string> = {
  ux_concept: "Нужен UX-путь, макет или прототип с описанием состояний и независимым дизайн-ревью. Результат — концепция; реализация продукта не входит.",
  api_integration: "Основной результат — рабочая интеграция с внешним API: документация, авторизация, контракт, повторы и ошибки, реализация и проверка обмена.",
  audit: "Нужна независимая оценка существующего объекта по критериям: рамки, доказательные находки, покрытие и проверка ложных срабатываний. Исправления не входят.",
  single_executor:
    "Небольшая или понятная работа: один исполнитель сделает её сам. Мелкая правка, текст, настройка, очевидный фикс без развилок.",
  research:
    "Нужно выяснить, сравнить или собрать факты и выводы, а не делать изменения в продукте. Результат — анализ, рекомендация, отчёт.",
  delivery:
    "Изменение в коде или продукте с техническим решением: архитектура, реализация, проверка вживую. Цель и требования уже ясны.",
  full_cycle:
    "Большая работа с высокой неопределённостью: сначала исследование и требования, затем техническое и UX-решение, реализация и проверка.",
};

export async function pickPlanProfileByJev(
  taskId: string,
): Promise<JevPlanProfilePick | null> {
  const cfg = jevPlanProfileConfig();
  if (!cfg) return null;
  const task = db
    .prepare("SELECT title, description FROM tasks WHERE id = ?")
    .get(taskId) as { title: string; description: string | null } | undefined;
  if (!task) return null;

  const result = await evaluateJev(
    { title: task.title, description: (task.description ?? "").slice(0, 6000) },
    {
      profile: {
        type: "choice",
        instructions: "Какой состав команды нужен для этой карточки задачи?",
        criteria: CRITERIA,
      },
    },
  );
  const answer = result?.answers?.profile;
  if (!answer || answer.type !== "choice") return null;
  if (!(answer.choice in CRITERIA)) return null;
  if (
    !(typeof answer.confidence === "number") ||
    answer.confidence < cfg.minConfidence
  )
    return null;
  return {
    profile: answer.choice as JevPlanProfile,
    confidence: answer.confidence,
  };
}
