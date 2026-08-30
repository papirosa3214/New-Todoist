// Экран «Работа агентов» — куда ведут плашки сводки на «Обзоре».
// Отвечает на вопрос «что сейчас у агентов»: какие задачи в работе, какие
// брошены (взялись и замолчали) и какие уже ждут проверки. Сделан по
// образцу ProjectTasksScreen: тот же ScreenHeader с кнопкой назад, те же
// строки TaskRow, та же обработка загрузки и ошибки — экран должен читаться
// как часть того же приложения, а не как отдельная панель.
//
// Разделы намеренно не пустуют: секция появляется только когда в ней есть
// задачи, иначе экран превращался бы в три подряд «пусто» — а он открывается
// именно затем, чтобы увидеть непустое.
import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTasks } from "../api/tasks";
import { ScreenHeader, ErrorBanner, Loading } from "../components/UI";
import { TaskRow } from "../components/TaskRow";

export function AgentWorkScreen() {
  const navigate = useNavigate();
  // ?focus=stale — пришли по плашке «Пропали»: тогда этот раздел идёт
  // первым. Без параметра порядок обычный: работа, потом брошенное, потом
  // проверка.
  const [params] = useSearchParams();
  const focus = params.get("focus");

  const { data: allTasks = [], isLoading, isError, error } = useTasks();

  const groups = useMemo(() => {
    const active = allTasks.filter((t) => t.status === "active");
    const inProgress = active.filter(
      (t) => t.agent_state === "in_progress" && !t.agent_stale,
    );
    // «Пропали» — то же условие, что и бейдж «Агент пропал» на карточке:
    // задача осталась в работе, а сигналов от агента давно нет.
    const stale = active.filter(
      (t) => t.agent_state === "in_progress" && t.agent_stale,
    );
    const review = active.filter((t) => t.agent_state === "review");
    const blocked = active.filter((t) => t.agent_state === "blocked");
    return { inProgress, stale, review, blocked };
  }, [allTasks]);

  const sections = useMemo(
    () => [
      {
        key: "in_progress",
        title: "В работе",
        hint: "Агент занят этими задачами прямо сейчас",
        tasks: groups.inProgress,
      },
      {
        key: "review",
        title: "На проверке",
        hint: "Агент закончил и сдал работу",
        tasks: groups.review,
      },
      {
        key: "blocked",
        title: "Заблокированы",
        hint: "Агент не может продолжить без вас",
        tasks: groups.blocked,
      },
      {
        key: "stale",
        title: "Пропали",
        hint: "Агент взялся и замолчал — задача висит без работы",
        tasks: groups.stale,
      },
    ],
    [groups],
  );

  const ordered = useMemo(() => {
    if (!focus) return sections;
    return [...sections].sort((a, b) => {
      if (a.key === focus) return -1;
      if (b.key === focus) return 1;
      return 0;
    });
  }, [focus, sections]);

  const nothing =
    !isLoading && !isError && ordered.every((s) => s.tasks.length === 0);

  return (
    <div className="px-4 pb-4">
      <ScreenHeader
        variant="compact"
        title="Работа агентов"
      />

      <ErrorBanner
        error={isError ? error : null}
        fallback="Не удалось загрузить задачи"
        variant="inline"
        className="mb-2"
      />

      {isLoading && <Loading />}

      {nothing && (
        <p className="px-1 text-[13px] text-dim">
          Агенты сейчас ничем не заняты — назначьте задачу, и она появится
          здесь.
        </p>
      )}

      {ordered.map((section) =>
        section.tasks.length === 0 ? null : (
          <div key={section.key} className="mb-4">
            <div className="px-1 pt-2 pb-1">
              <div className="text-[13px] font-semibold text-text">
                {section.title} {section.tasks.length}
              </div>
              <div className="text-[12px] text-sub">{section.hint}</div>
            </div>
            <div className="space-y-[2px]">
              {section.tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  onClick={() => navigate(`/task/${task.id}`)}
                />
              ))}
            </div>
          </div>
        ),
      )}
    </div>
  );
}
