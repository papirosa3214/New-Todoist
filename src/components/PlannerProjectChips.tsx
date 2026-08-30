// Шаг 2 (feature/projects-decouple-planner-merge): полоска чипов под
// шапкой «Сегодня»/«Предстоящего», показывает текущий opt-in список
// проектов + неснимаемый чип «Входящие» + кнопку [+ проект]. Тап по
// [+] вызывает onAdd — экран открывает TaskFilterSheet с раскрытой
// секцией «Показывать в разделе». Удаление чипов через саму полоску
// НЕ делается (Максим: «свайп по чипу — слишком мелкая цель, лучше
// явная кнопка») — для удаления служит picker. onRemove оставлен в
// пропе как зарезервированная дырка на случай Шага 3 / смены курса.
//
// Sticky-полоса под шапкой: data-hswipe и top: var(--screen-header-h, 0px)
// — паттерн из NoteEditorScreen.tsx (горизонтальный скролл без конфликта
// с вертикальным свайпом экрана). Скроллбар у .overflow-x-auto скрыт
// глобально в index.css (lines 1181-1189), дополнительных утилит не
// нужно.
import { Icon } from "./UI";
import { selectVisibleProjects } from "./plannerVisibleProjects";
import type { ApiProject } from "../api/types";

export interface PlannerProjectChipsProps {
  projects: ApiProject[];
  visibleProjectIds: Record<string, true>;
  onAdd: () => void;
  // Зарезервировано: чипы без [×] по решению Максима, но если Шаг 3
  // передумает — дёрнуть onRemove(projectId) отсюда ничего не стоит.
  onRemove?: (projectId: string) => void;
}

export function PlannerProjectChips({
  projects,
  visibleProjectIds,
  onAdd,
  onRemove,
}: PlannerProjectChipsProps) {
  const visible = selectVisibleProjects(projects, visibleProjectIds);

  return (
    <div
      data-hswipe
      style={{ top: 0 }}
      className="sticky z-10 bg-bg border-b border-stroke"
    >
      <div className="flex items-center gap-2 overflow-x-auto px-4 py-2 -mx-4">
        {/* Неснимаемый chip «Входящие» — обозначает, что режим
            «только входящие» включён по умолчанию. Не интерактивный:
            удалить «входящие» нельзя. */}
        <span
          aria-label="Входящие"
          className="shrink-0 px-3 py-1 rounded-full text-[12px] font-medium bg-card2 text-text border border-stroke"
        >
          Входящие
        </span>

        {visible.map((p) => (
          <button
            key={p.id}
            type="button"
            // onRemove опционален — в Шаге 2 не вызывается, но если
            // когда-то понадобится, тап по чипу = убрать из раздела.
            onClick={onRemove ? () => onRemove(p.id) : undefined}
            aria-label={`Проект ${p.name}`}
            // Тот же приём с фоном 15% alpha, что у меток в
            // TaskFields.tsx (max-w + truncate — в полоске места мало).
            className="shrink-0 flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-medium max-w-[160px] truncate"
            style={{
              backgroundColor: (p.color || "#999") + "26",
              color: p.color || "#999",
            }}
          >
            <span className="truncate">{p.name}</span>
          </button>
        ))}

        <button
          type="button"
          onClick={onAdd}
          aria-label="Добавить проект"
          className="shrink-0 px-3 py-1 rounded-full text-[12px] font-medium border border-dashed border-stroke text-sub hover:text-text"
        >
          <Icon name="plus" size={12} className="inline-block mr-1 -mt-0.5" />
          проект
        </button>
      </div>
    </div>
  );
}
