import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface User {
  id: string;
  name: string;
  email: string;
  role: "owner" | "agent" | "viewer";
  type: "human" | "ai";
  avatarColor: string;
  initials: string;
  status: "online" | "offline";
  capabilities?: string[];
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  dueDate?: string;
  projectId?: string;
  priority: 1 | 2 | 3 | 4;
  assigneeId?: string;
  labels: string[];
  subtasks: Subtask[];
  comments: Comment[];
  status: "active" | "completed";
  createdAt: string;
}

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export interface Comment {
  id: string;
  userId: string;
  text: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  taskCount: number;
}

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface AppNotification {
  id: string;
  type: "assigned" | "completed" | "commented" | "subtask_created" | "new_task";
  userId: string;
  taskId: string;
  taskTitle: string;
  text: string;
  timestamp: string;
  read: boolean;
}

interface AppState {
  currentUser: User | null;
  tasks: Task[];
  projects: Project[];
  labels: Label[];
  users: User[];
  notifications: AppNotification[];
  settings: {
    theme: "dark" | "light";
    calendarView: "month" | "week";
  };

  // Actions
  setCurrentUser: (user: User | null) => void;
  addTask: (task: Task) => void;
  updateTask: (id: string, updates: Partial<Task>) => void;
  deleteTask: (id: string) => void;
  addProject: (project: Project) => void;
  addLabel: (label: Label) => void;
  markNotificationRead: (id: string) => void;
  setCalendarView: (view: "month" | "week") => void;
}

// ═══════════ SEED DATA (from mockup) ═══════════

const SEED_USERS: User[] = [
  {
    id: "u1",
    name: "Максим",
    email: "m89818052377@gmail.com",
    role: "owner",
    type: "human",
    avatarColor: "#35B8A3",
    initials: "М",
    status: "online",
  },
  {
    id: "u2",
    name: "Claude_Bot",
    email: "claude@taskflow.local",
    role: "agent",
    type: "ai",
    avatarColor: "#A78BFA",
    initials: "C",
    status: "online",
    capabilities: ["Код", "Ревью"],
  },
  {
    id: "u3",
    name: "Hermes",
    email: "hermes@taskflow.local",
    role: "agent",
    type: "ai",
    avatarColor: "#FF9A14",
    initials: "H",
    status: "online",
    capabilities: ["DevOps", "Инфра"],
  },
];

const SEED_PROJECTS: Project[] = [
  { id: "p1", name: "Входящие", color: "#4A9FD8", taskCount: 9 },
  { id: "p2", name: "Клод и Максим", color: "#A78BFA", taskCount: 3 },
  { id: "p3", name: "Цикл продаж", color: "#E44332", taskCount: 0 },
  { id: "p4", name: "Настройка проектов", color: "#FF9A14", taskCount: 0 },
  { id: "p5", name: "Ипотека", color: "#FF7A8A", taskCount: 0 },
  { id: "p6", name: "лягушка", color: "#8FBF9F", taskCount: 0 },
];

const SEED_LABELS: Label[] = [
  { id: "l1", name: "Ипотека", color: "#FF7A8A" },
  { id: "l2", name: "база-знаний", color: "#FF7A8A" },
  { id: "l3", name: "Клод и Максим", color: "#A78BFA" },
];

const SEED_TASKS: Task[] = [
  { id: "t1", title: "Оплатить коммуналку — авгуcт 2026", description: "Квитанция на 8 432₽. Оплата до 25-го числа.", dueDate: "2026-08-25", projectId: "p1", priority: 1, labels: [], subtasks: [], comments: [], status: "active", createdAt: "2026-08-01" },
  { id: "t2", title: "Судебное заседание", description: "Кабинет 232. Слушание по моему делу, озвучить свои возражения по иску. Подготовить копии всех документов. Кратко пересказать суть спора.", dueDate: "2026-08-11", projectId: "p1", priority: 1, labels: ["Ипотека"], subtasks: [], comments: [], status: "active", createdAt: "2026-08-01" },
  { id: "t3", title: "Выпустить ЭЦП", description: "Через «Правовед» или Госуслуги. Стоимость 1 500–2 500₽. Понадобится паспорт и снилс.", dueDate: "2026-08-15", projectId: "p1", priority: 2, labels: [], subtasks: [
    { id: "st1", title: "Получить ЭЦП в налоговой", done: false },
    { id: "st2", title: "Проверить сертификат в личном кабинете", done: false },
  ], comments: [], status: "active", createdAt: "2026-08-01" },
  { id: "t4", title: "Сдать показания счётчиков", description: "ГВС и ХВС. Не позже 28 августа.", dueDate: "2026-08-28", projectId: "p1", priority: 1, labels: [], subtasks: [], comments: [], status: "active", createdAt: "2026-08-01" },
  { id: "t5", title: "Убрать квартиру", description: "Генеральная уборка кухни и ванной. Заправить постели, помыть полы, протереть пыль, помыть зеркала.", dueDate: "2026-08-17", projectId: "p1", priority: 1, labels: [], subtasks: [], comments: [], status: "active", createdAt: "2026-08-01" },
  { id: "t6", title: "Изучить Госуслуги", description: "Разобраться: где мои документы, заявления, штрафы, налоги. Проверить статусы всех обращений.", dueDate: "2026-08-14", projectId: "p1", priority: 2, labels: [], subtasks: [], comments: [], status: "active", createdAt: "2026-08-01" },
  { id: "t7", title: "Настроить ИИ для семьи", description: "Claude, ChatGPT, Gemini — подключить под FAMILY_USE.", dueDate: "2026-08-18", projectId: "p1", priority: 2, labels: [], subtasks: [], comments: [], status: "active", createdAt: "2026-08-01" },
  { id: "t8", title: "Оплатить ипотеку — сентябрь", description: "Ежемесячный платёж. Сумма будет уточнена. Контроль даты списания.", dueDate: "2026-09-01", projectId: "p1", priority: 1, labels: ["Ипотека"], subtasks: [], comments: [], status: "active", createdAt: "2026-08-01" },
  { id: "t9", title: "Связаться с банком", description: "Уточнить по графику платежей и текущему остатку долга по ипотеке. Спросить про рефинансирование.", dueDate: "2026-08-16", projectId: "p1", priority: 1, labels: ["Ипотека"], subtasks: [], comments: [], status: "active", createdAt: "2026-08-01" },
  { id: "t10", title: "База знаний: единый источник правды и синхронизация через git", description: "С чего начать разговор: спросить Клода «что там с базой знаний?» — он расскажет.", dueDate: "2026-08-12", projectId: "p2", priority: 3, assigneeId: "u2", labels: ["база-знаний", "Клод и Максим"], subtasks: [
    { id: "st3", title: "Слить две папки уроков в одну + включить синхронизацию", done: false },
    { id: "st4", title: "Настроить агента для парсинга видеоуроков", done: false },
  ], comments: [], status: "active", createdAt: "2026-08-01" },
  { id: "t11", title: "Настроить автоматические бэкапы на внешний диск", description: "Ежедневный крон. rsync с дедупликацией.", dueDate: "2026-08-13", projectId: "p2", priority: 2, assigneeId: "u3", labels: ["Клод и Максим"], subtasks: [], comments: [], status: "active", createdAt: "2026-08-01" },
];

const SEED_NOTIFICATIONS: AppNotification[] = [
  { id: "n1", type: "assigned", userId: "u2", taskId: "t2", taskTitle: "Судебное заседание", text: "Claude_Bot назначен на задачу", timestamp: "2 мин. назад", read: false },
  { id: "n2", type: "completed", userId: "u3", taskId: "t7", taskTitle: "Настроить ИИ для семьи", text: "Hermes завершил задачу", timestamp: "15 мин. назад", read: false },
  { id: "n3", type: "new_task", userId: "u1", taskId: "t1", taskTitle: "Оплатить коммуналку — август 2026", text: "Новая задача назначена вам", timestamp: "1 час назад", read: true },
  { id: "n4", type: "commented", userId: "u2", taskId: "t10", taskTitle: "База знаний", text: "Claude_Bot прокомментировал", timestamp: "2 часа назад", read: true },
  { id: "n5", type: "subtask_created", userId: "u3", taskId: "t3", taskTitle: "Выпустить ЭЦП", text: "Hermes создал подзадачу: Получить ЭЦП в налоговой", timestamp: "Вчера", read: true },
];

// ═══════════ ZUSTAND STORE ═══════════

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      currentUser: SEED_USERS[0],
      tasks: SEED_TASKS,
      projects: SEED_PROJECTS,
      labels: SEED_LABELS,
      users: SEED_USERS,
      notifications: SEED_NOTIFICATIONS,
      settings: { theme: "dark", calendarView: "month" },

      setCurrentUser: (user) => set({ currentUser: user }),
      addTask: (task) => set((s) => ({ tasks: [...s.tasks, task] })),
      updateTask: (id, updates) =>
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
        })),
      deleteTask: (id) =>
        set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
      addProject: (project) =>
        set((s) => ({ projects: [...s.projects, project] })),
      addLabel: (label) =>
        set((s) => ({ labels: [...s.labels, label] })),
      markNotificationRead: (id) =>
        set((s) => ({
          notifications: s.notifications.map((n) =>
            n.id === id ? { ...n, read: true } : n,
          ),
        })),
      setCalendarView: (view) =>
        set((s) => ({ settings: { ...s.settings, calendarView: view } })),
    }),
    { name: "taskflow-store" },
  ),
);