import type { ApiTask } from "../api/types";

export function AttemptLadderBadge({ task }: { task: ApiTask }) {
  const ladder = task.attempt_ladder;
  if (!ladder || ladder.current_step < 1 || ladder.total_steps < 1) return null;

  const escalated = ladder.current_step > 1 || task.agent_state === "blocked";
  const tone = escalated
    ? "border-amber-500/30 bg-amber-500/10 text-amber-500"
    : "border-border bg-card text-sub";
  const model = ladder.current_model || "модель не указана";

  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium ${tone}`}
      aria-label={`Попытка ${ladder.current_step} из ${ladder.total_steps}, ${model}`}
    >
      <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-current/10 px-1 tabular-nums">
        {ladder.current_step}/{ladder.total_steps}
      </span>
      <span aria-hidden="true">→</span>
      <span>{model}</span>
    </div>
  );
}
