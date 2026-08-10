import { useNavigate } from "react-router-dom";
import { useAppStore } from "../store";
import { Icon } from "../components/UI";

export function ProjectsScreen() {
  const navigate = useNavigate();
  const projects = useAppStore((s) => s.projects);

  return (
    <div className="px-4 pb-4">
      <div className="flex items-center h-[48px] mb-2 relative">
        <button onClick={() => navigate(-1)} className="w-[36px] h-[36px]">
          <Icon name="chevronLeft" size={22} />
        </button>
        <h2 className="absolute left-1/2 -translate-x-1/2 text-[17px] font-semibold">
          Проекты
        </h2>
        <button className="absolute right-0 w-[36px] h-[36px] rounded-[10px] bg-card flex items-center justify-center">
          <Icon name="plus" size={18} />
        </button>
      </div>

      <div className="space-y-[2px]">
        {projects.map((p) => (
          <button
            key={p.id}
            className="w-full flex items-center gap-3 py-3 px-4 bg-card rounded-xl text-left"
          >
            <div
              className="w-[28px] h-[28px] rounded-lg flex items-center justify-center"
              style={{ backgroundColor: p.color + "20" }}
            >
              <Icon name="hash" size={16} style={{ color: p.color }} />
            </div>
            <div className="flex-1">
              <div className="text-[15px] text-text">{p.name}</div>
              <div className="text-[12px] text-sub">{p.taskCount} задач</div>
            </div>
            <Icon name="chevron" size={16} className="text-dim" />
          </button>
        ))}
      </div>

      <button className="w-full flex items-center gap-3 py-3 px-4 mt-4 border border-dashed border-stroke rounded-xl">
        <Icon name="plus" size={18} className="text-dim" />
        <span className="text-[14px] text-sub">Создать проект</span>
      </button>
    </div>
  );
}
