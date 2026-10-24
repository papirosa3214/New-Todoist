export interface TaskTemplate {
  id: string;
  title: string;
  description?: string;
  priority?: number;
  subtasks?: string[];
  labels?: string[];
  estimated_min?: number;
  category?: string;
  is_builtin?: boolean;
  created_at?: string;
}

export const BUILTIN_TEMPLATES: TaskTemplate[] = [
  {
    id: "builtin-onboarding",
    title: "🚀 Старт нового проекта",
    description: "Пошаговый чеклист запуска нового проекта от идеи до первого релиза",
    priority: 1,
    category: "Разработка",
    is_builtin: true,
    subtasks: [
      "Собрать требования и составить ТЗ",
      "Описать архитектуру и схему базы данных",
      "Настроить репозиторий и CI/CD пайплайн",
      "Реализовать базовый каркас и API",
      "Написать unit-тесты для критических модулей",
      "Провести демо и собрать первую обратную связь",
    ],
  },
  {
    id: "builtin-weekly-review",
    title: "🎯 Еженедельный обзор (Weekly Review)",
    description: "Регулярная сверка планов, разбор входящих и актуализация приоритетов",
    priority: 2,
    category: "Продуктивность",
    is_builtin: true,
    subtasks: [
      "Разобрать Входящие (Inbox) до нуля",
      "Просмотреть задачи на текущую и следующую неделю",
      "Проверить статус работы у назначенных AI-агентов",
      "Актуализировать дедлайны и приоритеты",
      "Сформулировать топ-3 главные цели на неделю",
    ],
  },
  {
    id: "builtin-release-prep",
    title: "📦 Подготовка и выпуск релиза",
    description: "Чеклист проверки перед публикацией обновления в прод и на устройства",
    priority: 1,
    category: "Разработка",
    is_builtin: true,
    subtasks: [
      "Прогнать тесты фронтенда (npm test) и сервера (npm test)",
      "Собрать список изменений (Changelog) в STATUS.md",
      "Собрать production веб-бандл (npm run build)",
      "Собрать Release iOS-билд в Xcode",
      "Установить и протестировать на физическом iPhone",
      "Сделать git commit и git push в основной репозиторий",
    ],
  },
  {
    id: "builtin-bug-investigation",
    title: "🐛 Анализ и исправление бага",
    description: "Стандартный процесс локализации и устранения дефекта",
    priority: 2,
    category: "Разработка",
    is_builtin: true,
    subtasks: [
      "Воспроизвести проблему и зафиксировать шаги",
      "Собрать логи сервера и клиентские ошибки",
      "Локализовать причину в коде",
      "Написать тест, воспроизводящий дефект",
      "Реализовать исправление",
      "Проверить регрессию и закрыть инцидент",
    ],
  },
  {
    id: "builtin-travel-checklist",
    title: "🧳 Сборы в поездку / путешествие",
    description: "Чеклист необходимых вещей и документов перед выездом",
    priority: 3,
    category: "Личное",
    is_builtin: true,
    subtasks: [
      "Проверить паспорт, билеты и бронь отеля",
      "Собрать зарядные устройства, кабели и пауэрбанк",
      "Подготовить аптечку и базовые медикаменты",
      "Собрать одежду по прогнозу погоды",
      "Проверить ключи, выключить электроприборы и воду дома",
    ],
  },
  {
    id: "builtin-workout",
    title: "🏋️ Тренировка и ЗОЖ",
    description: "План регулярной тренировочной сессии",
    priority: 3,
    category: "Здоровье",
    is_builtin: true,
    subtasks: [
      "Разминка и суставная гимнастика (10 мин)",
      "Основной блок упражнений (силовая / кардио 40 мин)",
      "Заминка и растяжка (10 мин)",
      "Зафиксировать вес, пульс и общее самочувствие",
    ],
  },
];

const STORAGE_KEY = "taskflow_user_templates_v1";

export const TemplateStore = {
  getUserTemplates(): TaskTemplate[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  getAllTemplates(): TaskTemplate[] {
    const user = this.getUserTemplates();
    return [...user, ...BUILTIN_TEMPLATES];
  },

  saveTemplate(template: Omit<TaskTemplate, "id" | "is_builtin" | "created_at">): TaskTemplate {
    const user = this.getUserTemplates();
    const newTemplate: TaskTemplate = {
      ...template,
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      is_builtin: false,
      created_at: new Date().toISOString(),
    };
    user.unshift(newTemplate);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    return newTemplate;
  },

  updateTemplate(id: string, patch: Partial<TaskTemplate>): void {
    const user = this.getUserTemplates();
    const idx = user.findIndex((t) => t.id === id);
    if (idx !== -1) {
      user[idx] = { ...user[idx], ...patch };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    }
  },

  deleteTemplate(id: string): void {
    const user = this.getUserTemplates().filter((t) => t.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  },
};
