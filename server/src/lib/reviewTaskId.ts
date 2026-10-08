/** Review belongs to the whole card, never the slot. Do not cross task/actor scope. */
export function resolveReviewTaskId(requested: string, taskId: string, actorId: string,
  step?: { task_id: string; agent_id: string | null }): string {
  if (requested === taskId) return taskId;
  if (step?.task_id === taskId && step.agent_id === actorId) return taskId;
  throw new Error("Вердикт относится к текущей задаче. Передай id задачи " + taskId +
    ", а не id шага или другой карточки.");
}
