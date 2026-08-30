import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon, ScreenHeader, ErrorBanner } from "../components/UI";
import { TemplateStore, type TaskTemplate } from "../lib/templates";
import { useCreateTask } from "../api/tasks";
import { getErrorMessage } from "../lib/errors";
import { PRIORITIES } from "../lib/priority";

export function TemplatesScreen() {
  const navigate = useNavigate();
  const createTask = useCreateTask();

  const [templates, setTemplates] = useState<TaskTemplate[]>(() =>
    TemplateStore.getAllTemplates(),
  );
  const [showCreate, setShowCreate] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<TaskTemplate | null>(null);

  // Form state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(4);
  const [subtasksText, setSubtasksText] = useState("");
  const [category, setCategory] = useState("Общее");
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshTemplates = () => {
    setTemplates(TemplateStore.getAllTemplates());
  };

  const handleOpenCreate = () => {
    setEditingTemplate(null);
    setTitle("");
    setDescription("");
    setPriority(4);
    setSubtasksText("");
    setCategory("Общее");
    setError(null);
    setShowCreate(true);
  };

  const handleOpenEdit = (t: TaskTemplate) => {
    if (t.is_builtin) return;
    setEditingTemplate(t);
    setTitle(t.title);
    setDescription(t.description || "");
    setPriority(t.priority || 4);
    setSubtasksText(t.subtasks ? t.subtasks.join("\n") : "");
    setCategory(t.category || "Общее");
    setError(null);
    setShowCreate(true);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Укажите название шаблона");
      return;
    }

    const subtasks = subtasksText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (editingTemplate) {
      TemplateStore.updateTemplate(editingTemplate.id, {
        title: trimmedTitle,
        description: description.trim() || undefined,
        priority,
        subtasks,
        category: category.trim() || "Общее",
      });
    } else {
      TemplateStore.saveTemplate({
        title: trimmedTitle,
        description: description.trim() || undefined,
        priority,
        subtasks,
        category: category.trim() || "Общее",
      });
    }

    setShowCreate(false);
    refreshTemplates();
    setSuccessMessage(
      editingTemplate ? "Шаблон обновлён" : "Новый шаблон успешно сохранён",
    );
    setTimeout(() => setSuccessMessage(null), 3000);
  };

  const handleDelete = (id: string) => {
    TemplateStore.deleteTemplate(id);
    refreshTemplates();
    setSuccessMessage("Шаблон удалён");
    setTimeout(() => setSuccessMessage(null), 3000);
  };

  const handleApplyTemplate = async (template: TaskTemplate) => {
    setError(null);
    try {
      const res = await createTask.mutateAsync({
        title: template.title.replace(/^[^\wа-яёА-ЯЁ0-9]+\s*/, ""), // Убираем эмодзи в начале, если есть
        description: template.description,
        priority: template.priority,
        subtasks: template.subtasks?.map((title) => ({ title })),
      });

      if (res?.task?.id) {
        navigate(`/task/${res.task.id}`);
      } else {
        setSuccessMessage(`Задача создана из шаблона «${template.title}»`);
        setTimeout(() => setSuccessMessage(null), 3000);
      }
    } catch (err) {
      setError(`Ошибка создания задачи: ${getErrorMessage(err)}`);
    }
  };

  const userTemplates = templates.filter((t) => !t.is_builtin);
  const builtinTemplates = templates.filter((t) => t.is_builtin);

  // Красная кнопка панели заводит шаблон — плюсик из шапки убран
  // (27.08.2026, владелец: «кружочек этот красный вместо вот этих всяких
  // плюсиков левых наверху»).

  return (
    <div className="min-h-screen bg-bg text-text pb-12">
      <ScreenHeader
        variant="compact"
        title="Шаблоны задач"
      />

      <div className="px-4 space-y-6 max-w-lg mx-auto pt-2">
        {error && <ErrorBanner error={error} variant="block" />}

        {successMessage && (
          <div className="bg-card border border-teal/30 rounded-xl p-3 flex items-center gap-3 text-sm text-teal">
            <Icon name="check" size={18} className="shrink-0" />
            <span>{successMessage}</span>
          </div>
        )}

        {/* Modal / Form for creating or editing template */}
        {showCreate && (
          <form
            onSubmit={handleSave}
            className="bg-card border border-stroke/60 rounded-2xl p-4 space-y-4 shadow-lg"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text">
                {editingTemplate ? "Редактировать шаблон" : "Новый шаблон"}
              </h3>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="text-sub p-1 tap-row"
              >
                <Icon name="x" size={16} />
              </button>
            </div>

            <div>
              <label className="text-xs text-sub mb-1 block">Название шаблона</label>
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="например: 🚀 Онбординг проекта"
                className="w-full bg-card2 rounded-xl px-3 py-2.5 text-sm text-text placeholder:text-dim outline-none"
              />
            </div>

            <div>
              <label className="text-xs text-sub mb-1 block">Описание (опционально)</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Краткое описание назначения шаблона..."
                rows={2}
                className="w-full bg-card2 rounded-xl px-3 py-2 text-sm text-text placeholder:text-dim outline-none resize-none"
              />
            </div>

            <div>
              <label className="text-xs text-sub mb-1 block">Приоритет</label>
              <div className="flex items-center gap-2">
                {PRIORITIES.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setPriority(p.key)}
                    className={`flex-1 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                      priority === p.key
                        ? "bg-card2 ring-1 ring-white/30 text-white"
                        : "bg-card2/50 text-sub opacity-70"
                    }`}
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: p.color }}
                    />
                    <span>{p.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs text-sub mb-1 block">
                Подзадачи (каждая с новой строки)
              </label>
              <textarea
                value={subtasksText}
                onChange={(e) => setSubtasksText(e.target.value)}
                placeholder="Собрать требования&#10;Описать схему базы данных&#10;Написать тесты"
                rows={4}
                className="w-full bg-card2 rounded-xl px-3 py-2 text-sm text-text placeholder:text-dim outline-none font-mono text-xs"
              />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="flex-1 h-11 rounded-xl bg-card2 text-sm text-sub font-semibold tap-row"
              >
                Отмена
              </button>
              <button
                type="submit"
                disabled={!title.trim()}
                className="flex-1 h-11 rounded-xl bg-red text-sm text-white font-semibold disabled:opacity-50 tap-fade"
              >
                Сохранить
              </button>
            </div>
          </form>
        )}

        {/* ═══════════ Пользовательские шаблоны ═══════════ */}
        <div>
          <div className="flex items-center justify-between px-1 mb-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-sub">
              Мои шаблоны ({userTemplates.length})
            </h2>
            {!showCreate && (
              <button
                onClick={handleOpenCreate}
                className="text-xs font-semibold text-red tap-fade"
              >
                + Добавить
              </button>
            )}
          </div>

          {userTemplates.length === 0 ? (
            <div className="p-4 bg-card rounded-xl border border-stroke/40 text-center text-xs text-dim">
              У вас пока нет сохранённых шаблонов. Нажмите «+ Добавить» или сохраните любую существующую задачу как шаблон из её карточки.
            </div>
          ) : (
            <div className="space-y-2">
              {userTemplates.map((t) => (
                <div
                  key={t.id}
                  className="bg-card border border-stroke/50 rounded-xl p-3.5 space-y-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-text truncate">
                        {t.title}
                      </div>
                      {t.description && (
                        <div className="text-xs text-sub mt-0.5 line-clamp-2">
                          {t.description}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleOpenEdit(t)}
                        className="p-1.5 text-dim hover:text-text tap-row"
                        aria-label="Редактировать"
                      >
                        <Icon name="edit" size={15} />
                      </button>
                      <button
                        onClick={() => handleDelete(t.id)}
                        className="p-1.5 text-dim hover:text-red tap-row"
                        aria-label="Удалить"
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    </div>
                  </div>

                  {t.subtasks && t.subtasks.length > 0 && (
                    <div className="text-[11px] text-dim bg-card2/60 rounded-lg px-2.5 py-1.5 space-y-0.5">
                      <div className="font-semibold text-sub">
                        Подзадач: {t.subtasks.length}
                      </div>
                      {t.subtasks.slice(0, 3).map((st, i) => (
                        <div key={i} className="truncate">
                          • {st}
                        </div>
                      ))}
                      {t.subtasks.length > 3 && (
                        <div className="italic text-dim">
                          и ещё {t.subtasks.length - 3}...
                        </div>
                      )}
                    </div>
                  )}

                  <button
                    onClick={() => handleApplyTemplate(t)}
                    disabled={createTask.isPending}
                    className="w-full h-9 bg-red/15 hover:bg-red/25 active:bg-red/30 text-red text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 tap-row"
                  >
                    <Icon name="plus" size={14} />
                    <span>Создать задачу по шаблону</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ═══════════ Готовые образцы шаблонов ═══════════ */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-sub px-1 mb-2">
            Готовые образцы ({builtinTemplates.length})
          </h2>

          <div className="space-y-2">
            {builtinTemplates.map((t) => (
              <div
                key={t.id}
                className="bg-card border border-stroke/50 rounded-xl p-3.5 space-y-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-text">
                      {t.title}
                    </div>
                    {t.description && (
                      <div className="text-xs text-sub mt-0.5">
                        {t.description}
                      </div>
                    )}
                  </div>
                  {t.category && (
                    <span className="text-[10px] uppercase font-bold text-dim bg-card2 px-2 py-0.5 rounded-full shrink-0">
                      {t.category}
                    </span>
                  )}
                </div>

                {t.subtasks && t.subtasks.length > 0 && (
                  <div className="text-[11px] text-dim bg-card2/60 rounded-lg px-2.5 py-1.5 space-y-0.5">
                    <div className="font-semibold text-sub">
                      Подзадач: {t.subtasks.length}
                    </div>
                    {t.subtasks.slice(0, 3).map((st, i) => (
                      <div key={i} className="truncate">
                        • {st}
                      </div>
                    ))}
                    {t.subtasks.length > 3 && (
                      <div className="italic text-dim">
                        и ещё {t.subtasks.length - 3}...
                      </div>
                    )}
                  </div>
                )}

                <button
                  onClick={() => handleApplyTemplate(t)}
                  disabled={createTask.isPending}
                  className="w-full h-9 bg-red/15 hover:bg-red/25 active:bg-red/30 text-red text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 tap-row"
                >
                  <Icon name="plus" size={14} />
                  <span>Создать задачу по шаблону</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
