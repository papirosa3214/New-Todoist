import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks } from "../api/tasks";
import { Icon } from "../components/UI";

export function SearchScreen() {
  const navigate = useNavigate();
  const { data: tasks = [] } = useTasks();
  const [query, setQuery] = useState("");

  const results = query.trim()
    ? tasks.filter(
        (t) =>
          t.title.toLowerCase().includes(query.toLowerCase()) ||
          t.description?.toLowerCase().includes(query.toLowerCase()),
      )
    : [];

  return (
    <div className="px-4 pb-4">
      <div className="sticky top-0 z-20 bg-bg/90 backdrop-blur-xl border-b border-stroke mb-4">
        <div className="flex items-center gap-3 h-[48px]">
          <div className="flex-1 flex items-center gap-2 bg-card rounded-xl px-3 py-2">
            <Icon name="search" size={18} className="text-dim" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Найти задачу или проект"
              className="flex-1 bg-transparent text-[16px] text-text placeholder:text-dim outline-none"
              autoFocus
            />
          </div>
          <button onClick={() => navigate(-1)} className="text-[15px] text-sub">
            Отмена
          </button>
        </div>
      </div>

      {results.length > 0 ? (
        <div className="space-y-[2px]">
          {results.map((t) => (
            <button
              key={t.id}
              onClick={() => navigate(`/task/${t.id}`)}
              className="w-full flex items-start gap-3 py-3 px-1 text-left border-b border-stroke/50"
            >
              <div className="mt-0.5 w-[18px] h-[18px] rounded-full border-2 border-red shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[15px] text-text truncate">{t.title}</div>
                {t.description && (
                  <div className="text-[13px] text-sub mt-0.5 truncate">
                    {t.description.substring(0, 60)}…
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      ) : query.trim() ? (
        <div className="text-center py-12 text-[14px] text-dim">
          Ничего не найдено
        </div>
      ) : (
        <div className="text-center py-12 text-[14px] text-dim">
          Начните вводить для поиска
        </div>
      )}
    </div>
  );
}
