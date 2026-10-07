// Когда подготовка плана мешает утвердить план (владелец 07.10.2026: «почему я не могу принять?»).
// Раньше мешало ВСЁ, что не «ready», — в том числе упавшая фоновая подготовка, хотя план уже собран
// (по шаблону) и от неё не зависит, а текст отказа не называл причину. Теперь блокируют только
// случаи, где план действительно может быть не тем: подготовка ещё идёт, ждёт уточнения, или план
// устарел относительно карточки.
export type PreparationJob = { status: string; plan_id: string | null; snapshot: string };
export type PreparedCard = { title: string; description: string | null; project_id: string | null };

/** Текст причины отказа или null — утверждать можно. */
export function preparationBlocker(job: PreparationJob | undefined | null, planId: string, card: PreparedCard): string | null {
  if (!job) return null;
  if (job.status === "queued" || job.status === "running") return "План ещё готовится — подождите, пока подготовка закончится.";
  if (job.status === "needs_clarification") return "Подготовка ждёт уточнения постановки — ответьте на вопрос в карточке.";
  if (job.status !== "ready") return null; // failed / skipped / superseded: плану не мешают
  if (job.plan_id !== planId) return "Есть более свежий план подготовки — обновите карточку.";
  let snap: Partial<PreparedCard> = {};
  try { snap = JSON.parse(job.snapshot); } catch { /* повреждённый снимок — считаем, что менялось */ return "Не удалось сверить план с карточкой — обновите план."; }
  if (snap.title !== card.title || snap.description !== card.description || snap.project_id !== card.project_id) {
    return "Название, описание или проект изменились после подготовки плана — обновите план.";
  }
  return null;
}
