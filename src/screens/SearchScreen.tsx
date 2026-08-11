import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSearch } from "../api/search";
import { Icon, ErrorBanner } from "../components/UI";

const PRIORITY_COLORS: Record<number, string> = {
  1: "#E44332",
  2: "#FF9A14",
  3: "#4A9FD8",
  4: "#A6A6A6",
};

export function SearchScreen() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  // Debounce the round-trip, not the input — the field stays responsive on
  // every keystroke, the server only sees one request per pause. Clearing
  // the field snaps `debouncedQuery` back immediately (no stale request
  // lingering behind an emptied box).
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setDebouncedQuery("");
      return;
    }
    const timer = setTimeout(() => setDebouncedQuery(trimmed), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const hasQuery = query.trim().length > 0;
  // True in the gap between typing and the debounced request actually
  // firing — react-query's own isLoading is false here (enabled:false),
  // so without this the screen would flash "ничего не найдено" on every
  // keystroke before the request has even gone out.
  const isDebouncing = hasQuery && debouncedQuery !== query.trim();

  const { data, isLoading, isError, error } = useSearch(debouncedQuery);
  const tasks = data?.tasks ?? [];
  const projects = data?.projects ?? [];
  const labels = data?.labels ?? [];
  const totalCount = tasks.length + projects.length + labels.length;

  const isSearching = hasQuery && (isDebouncing || isLoading);
  const showEmpty = hasQuery && !isSearching && !isError && totalCount === 0;
  const showResults = hasQuery && !isSearching && !isError && totalCount > 0;

  return (
    <div className="px-4 pb-4">
      <div className="sticky top-0 z-20 bg-bg/90 backdrop-blur-xl border-b border-stroke mb-4">
        <div className="flex items-center gap-2 h-[48px]">
          <div className="flex-1 flex items-center gap-2 bg-card rounded-xl px-3 h-[44px]">
            <Icon name="search" size={18} className="text-dim shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Задачи, проекты, метки"
              className="flex-1 min-w-0 bg-transparent text-[16px] text-text placeholder:text-dim outline-none"
              autoFocus
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                aria-label="Очистить поиск"
                className="w-[28px] h-[28px] -mr-1 flex items-center justify-center text-dim shrink-0"
              >
                <Icon name="x" size={16} />
              </button>
            )}
          </div>
          <button
            onClick={() => navigate(-1)}
            className="h-[44px] px-2 text-[15px] text-sub shrink-0"
          >
            Отмена
          </button>
        </div>
      </div>

      {!hasQuery && (
        <div className="text-center py-16 px-6">
          <Icon name="search" size={32} className="text-dim mx-auto mb-3" />
          <p className="text-[14px] text-dim">
            Начните вводить, чтобы найти задачи, проекты и метки
          </p>
        </div>
      )}

      {hasQuery && isError && (
        <ErrorBanner
          error={error}
          fallback="Не удалось выполнить поиск"
          variant="inline"
          className="mt-1 mb-3"
        />
      )}

      {hasQuery && isSearching && !isError && (
        <p className="px-1 text-[13px] text-dim">Ищем…</p>
      )}

      {showEmpty && (
        <div className="text-center py-16 px-6">
          <Icon name="search" size={32} className="text-dim mx-auto mb-3" />
          <p className="text-[14px] text-text mb-1">Ничего не найдено</p>
          <p className="text-[13px] text-dim">
            По запросу «{query.trim()}» нет ни задач, ни проектов, ни меток
          </p>
        </div>
      )}

      {showResults && (
        <div className="space-y-5">
          {tasks.length > 0 && (
            <div>
              <h3 className="text-[13px] font-semibold text-sub mb-2 px-1">
                Задачи
              </h3>
              <div className="space-y-[2px]">
                {tasks.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => navigate(`/task/${t.id}`)}
                    className="w-full flex items-start gap-3 py-3 px-1 text-left border-b border-stroke/50"
                  >
                    <div
                      className="mt-0.5 w-[18px] h-[18px] rounded-full border-2 shrink-0"
                      style={{
                        borderColor: PRIORITY_COLORS[t.priority] || "#4A9FD8",
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-[15px] text-text truncate">
                        {t.title}
                      </div>
                      {(t.project_name || t.description) && (
                        <div className="text-[12px] text-sub mt-0.5 truncate">
                          {t.project_name && (
                            <span
                              style={{ color: t.project_color || undefined }}
                            >
                              #{t.project_name}
                            </span>
                          )}
                          {t.project_name && t.description ? " · " : ""}
                          {t.description}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {projects.length > 0 && (
            <div>
              <h3 className="text-[13px] font-semibold text-sub mb-2 px-1">
                Проекты
              </h3>
              <div className="space-y-[2px]">
                {projects.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => navigate(`/projects/${p.id}`)}
                    className="w-full flex items-center gap-3 py-2.5 px-3 bg-card rounded-xl text-left"
                  >
                    <div
                      className="w-[28px] h-[28px] rounded-lg flex items-center justify-center shrink-0"
                      style={{ backgroundColor: p.color + "20" }}
                    >
                      <Icon name="hash" size={16} style={{ color: p.color }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[15px] text-text truncate">
                        {p.name}
                      </div>
                      <div className="text-[12px] text-sub">
                        {p.task_count} задач
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {labels.length > 0 && (
            <div>
              <h3 className="text-[13px] font-semibold text-sub mb-2 px-1">
                Метки
              </h3>
              <div className="space-y-[2px]">
                {/* Not a button: there's no label-detail route in the app
                    yet (only /task/:id and /projects/:id exist), so this
                    is a display-only row rather than a dead link. */}
                {labels.map((l) => (
                  <div
                    key={l.id}
                    className="w-full flex items-center gap-3 py-2.5 px-3 bg-card/60 rounded-xl"
                  >
                    <span
                      className="inline-flex items-center justify-center w-[28px] h-[28px] rounded-lg shrink-0"
                      style={{ backgroundColor: l.color + "20" }}
                    >
                      <Icon name="tag" size={14} style={{ color: l.color }} />
                    </span>
                    <span className="text-[15px] text-text">{l.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
