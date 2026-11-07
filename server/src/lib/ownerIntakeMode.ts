// Источник правды для тумблера «Система» (MAK-67). Миграция 037 ввела
// `users.task_intake_mode`. «automatic» значит «Система» включена и
// автоприём сам отдаёт задачи исполнителю; «manual» — только явное
// действие владельца. Вынесено в отдельный модуль, чтобы разорвать
// циклический импорт между `routes/task-collaboration-plans.ts` и
// `runtime/planSubtaskAdmission.ts` (admission нужна эта функция, а
// plans.ts — `unlockReadyPlanSubtasks`).
import db from "../db.js";

export type IntakeMode = "automatic" | "manual" | "unknown";

export function ownerIntakeMode(): IntakeMode {
  const row = db
    .prepare(
      "SELECT task_intake_mode FROM users WHERE role='owner' AND COALESCE(archived,0)=0 ORDER BY created_at LIMIT 1",
    )
    .get() as { task_intake_mode?: string } | undefined;
  if (!row) return "unknown";
  return row.task_intake_mode === "automatic" ? "automatic" : "manual";
}