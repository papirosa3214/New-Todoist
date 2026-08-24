import { registerPlugin, Capacitor } from "@capacitor/core";

export interface CalendarInfo {
  id: string;
  title: string;
  color: string;
  isDefault: boolean;
  allowsContentModifications?: boolean;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  calendarTitle: string;
  calendarColor: string;
  title: string;
  startDate: string; // ISO8601
  endDate: string; // ISO8601
  allDay: boolean;
  notes?: string;
  location?: string;
  url?: string;
}

export interface ReminderListInfo {
  id: string;
  title: string;
  color: string;
  isDefault: boolean;
}

export interface AppleReminder {
  id: string;
  listId: string;
  listTitle: string;
  title: string;
  notes?: string;
  isCompleted: boolean;
  dueDate?: string; // ISO8601
  priority: number;
  createdAt?: string;
}

export interface PermissionStatus {
  status: "authorized" | "denied" | "restricted" | "notDetermined" | "writeOnly" | "unknown";
  granted: boolean;
}

interface EventKitPluginInterface {
  requestCalendarAccess(): Promise<{ granted: boolean }>;
  requestRemindersAccess(): Promise<{ granted: boolean }>;
  getCalendarStatus(): Promise<PermissionStatus>;
  getRemindersStatus(): Promise<PermissionStatus>;
  getCalendars(): Promise<{ calendars: CalendarInfo[] }>;
  getEvents(options: {
    startDate: string;
    endDate: string;
    calendarIds?: string[];
  }): Promise<{ events: CalendarEvent[] }>;
  createEvent(options: {
    title: string;
    startDate: string;
    endDate: string;
    allDay?: boolean;
    calendarId?: string;
    notes?: string;
    location?: string;
  }): Promise<{ id: string }>;
  deleteEvent(options: { id: string }): Promise<{ success: boolean }>;
  getReminderLists(): Promise<{ lists: ReminderListInfo[] }>;
  getReminders(options?: {
    listId?: string;
    completed?: boolean;
  }): Promise<{ reminders: AppleReminder[] }>;
  createReminder(options: {
    title: string;
    listId?: string;
    notes?: string;
    dueDate?: string;
    priority?: number;
  }): Promise<{ id: string }>;
  completeReminder(options: {
    id: string;
    isCompleted?: boolean;
  }): Promise<{ success: boolean }>;
  deleteReminder(options: { id: string }): Promise<{ success: boolean }>;
}

const EventKit = registerPlugin<EventKitPluginInterface>("EventKit");

export const isAppleNative = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";

export const AppleIntegrations = {
  isAvailable: () => isAppleNative,

  // ═══════════ Права доступа ═══════════
  async getCalendarStatus(): Promise<PermissionStatus> {
    if (!isAppleNative) return { status: "denied", granted: false };
    try {
      return await EventKit.getCalendarStatus();
    } catch {
      return { status: "notDetermined", granted: false };
    }
  },

  async getRemindersStatus(): Promise<PermissionStatus> {
    if (!isAppleNative) return { status: "denied", granted: false };
    try {
      return await EventKit.getRemindersStatus();
    } catch {
      return { status: "notDetermined", granted: false };
    }
  },

  async requestCalendarAccess(): Promise<boolean> {
    if (!isAppleNative) return false;
    try {
      const res = await EventKit.requestCalendarAccess();
      return res.granted;
    } catch {
      return false;
    }
  },

  async requestRemindersAccess(): Promise<boolean> {
    if (!isAppleNative) return false;
    try {
      const res = await EventKit.requestRemindersAccess();
      return res.granted;
    } catch {
      return false;
    }
  },

  // ═══════════ Календарь ═══════════
  async getCalendars(): Promise<CalendarInfo[]> {
    if (!isAppleNative) return [];
    try {
      const res = await EventKit.getCalendars();
      return res.calendars || [];
    } catch {
      return [];
    }
  },

  async getEvents(startDate: string, endDate: string, calendarIds?: string[]): Promise<CalendarEvent[]> {
    if (!isAppleNative) return [];
    try {
      const res = await EventKit.getEvents({ startDate, endDate, calendarIds });
      return res.events || [];
    } catch {
      return [];
    }
  },

  async createEvent(event: {
    title: string;
    startDate: string;
    endDate: string;
    allDay?: boolean;
    calendarId?: string;
    notes?: string;
    location?: string;
  }): Promise<string | null> {
    if (!isAppleNative) return null;
    try {
      const res = await EventKit.createEvent(event);
      return res.id;
    } catch {
      return null;
    }
  },

  // ═══════════ Напоминания ═══════════
  async getReminderLists(): Promise<ReminderListInfo[]> {
    if (!isAppleNative) return [];
    try {
      const res = await EventKit.getReminderLists();
      return res.lists || [];
    } catch {
      return [];
    }
  },

  async getReminders(listId?: string): Promise<AppleReminder[]> {
    if (!isAppleNative) return [];
    try {
      const res = await EventKit.getReminders({ listId });
      return res.reminders || [];
    } catch {
      return [];
    }
  },

  async createReminder(reminder: {
    title: string;
    listId?: string;
    notes?: string;
    dueDate?: string;
    priority?: number;
  }): Promise<string | null> {
    if (!isAppleNative) return null;
    try {
      const res = await EventKit.createReminder(reminder);
      return res.id;
    } catch {
      return null;
    }
  },

  async completeReminder(id: string, isCompleted: boolean = true): Promise<boolean> {
    if (!isAppleNative) return false;
    try {
      const res = await EventKit.completeReminder({ id, isCompleted });
      return res.success;
    } catch {
      return false;
    }
  },

  async deleteReminder(id: string): Promise<boolean> {
    if (!isAppleNative) return false;
    try {
      const res = await EventKit.deleteReminder({ id });
      return res.success;
    } catch {
      return false;
    }
  },

  // ═══════════ Двусторонняя синхронизация (2-way sync) ═══════════
  getRemindersMap(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem("apple_reminders_map") || "{}");
    } catch {
      return {};
    }
  },

  setRemindersMap(map: Record<string, string>): void {
    localStorage.setItem("apple_reminders_map", JSON.stringify(map));
  },

  /** Экспорт одной задачи TaskFlow в Apple Напоминания */
  async syncTaskToApple(task: {
    id: string;
    title: string;
    description?: string | null;
    due_date?: string | null;
    priority?: number;
    status?: string;
  }): Promise<void> {
    if (!isAppleNative) return;
    const perm = await this.getRemindersStatus();
    if (!perm.granted) return;

    const listId = localStorage.getItem("apple_reminders_list_id") || undefined;
    const map = this.getRemindersMap();
    const existingReminderId = map[task.id];

    if (existingReminderId) {
      // Обновляем статус завершения
      if (task.status === "completed") {
        await this.completeReminder(existingReminderId, true);
      }
    } else {
      // Создаём новое напоминание в Apple
      const newRemId = await this.createReminder({
        title: task.title,
        notes: task.description || undefined,
        dueDate: task.due_date ? `${task.due_date}T09:00:00` : undefined,
        priority: task.priority || 0,
        listId,
      });

      if (newRemId) {
        map[task.id] = newRemId;
        map[newRemId] = task.id;
        this.setRemindersMap(map);
      }
    }
  },

  /** Удаление напоминания из Apple при удалении задачи в TaskFlow */
  async deleteTaskFromApple(taskId: string): Promise<void> {
    if (!isAppleNative) return;
    const map = this.getRemindersMap();
    const remId = map[taskId];
    if (remId) {
      await this.deleteReminder(remId);
      delete map[taskId];
      delete map[remId];
      this.setRemindersMap(map);
    }
  },

  /** Полная двусторонняя синхронизация TaskFlow <-> Apple Напоминания */
  async syncAllReminders(
    tasks: Array<{
      id: string;
      title: string;
      description?: string | null;
      due_date?: string | null;
      status?: string;
      priority?: number;
    }>,
    createTaskInTaskFlow: (task: {
      title: string;
      description?: string;
      due_date?: string;
      start_time?: string;
      priority?: number;
      project_id?: string;
    }) => Promise<any>,
    updateTaskInTaskFlow: (task: {
      id: string;
      status?: "active" | "completed";
      title?: string;
    }) => Promise<any>,
    defaultProjectId?: string,
  ): Promise<{ imported: number; exported: number; updated: number }> {
    if (!isAppleNative) return { imported: 0, exported: 0, updated: 0 };
    const perm = await this.getRemindersStatus();
    if (!perm.granted) return { imported: 0, exported: 0, updated: 0 };

    const listId = localStorage.getItem("apple_reminders_list_id") || undefined;
    const appleReminders = await this.getReminders(listId);
    const map = this.getRemindersMap();

    let imported = 0;
    let exported = 0;
    let updated = 0;

    // 1. Импорт из Apple Reminders в TaskFlow (новые или измененные напоминания)
    for (const rem of appleReminders) {
      const mappedTaskId = map[rem.id];
      const existingTask = mappedTaskId ? tasks.find((t) => t.id === mappedTaskId) : undefined;

      if (!existingTask) {
        // Создаем задачу в TaskFlow в проекте "Apple Напоминания"
        let dueDate: string | undefined = undefined;
        let startTime: string | undefined = undefined;
        if (rem.dueDate) {
          const parts = rem.dueDate.split("T");
          dueDate = parts[0];
          if (parts[1]) {
            const timeParts = parts[1].split(":");
            if (timeParts.length >= 2 && !(timeParts[0] === "00" && timeParts[1] === "00")) {
              startTime = `${timeParts[0]}:${timeParts[1]}`;
            }
          }
        }

        try {
          const res = await createTaskInTaskFlow({
            title: rem.title,
            description: rem.notes,
            due_date: dueDate,
            start_time: startTime,
            priority: rem.priority,
            project_id: defaultProjectId,
          });

          if (res?.task?.id) {
            map[res.task.id] = rem.id;
            map[rem.id] = res.task.id;
            imported++;
          }
        } catch {
          // ignore individual error
        }
      } else {
        // Обновляем статус если завершено в Apple
        if (rem.isCompleted && existingTask.status !== "completed") {
          try {
            await updateTaskInTaskFlow({ id: existingTask.id, status: "completed" });
            updated++;
          } catch {
            // ignore
          }
        }
      }
    }

    // 2. Экспорт задач из TaskFlow в Apple Reminders (если ещё нет в Apple)
    for (const task of tasks) {
      if (!map[task.id] && task.status !== "completed") {
        try {
          const newRemId = await this.createReminder({
            title: task.title,
            notes: task.description || undefined,
            dueDate: task.due_date ? `${task.due_date}T09:00:00` : undefined,
            priority: task.priority || 0,
            listId,
          });
          if (newRemId) {
            map[task.id] = newRemId;
            map[newRemId] = task.id;
            exported++;
          }
        } catch {
          // ignore
        }
      }
    }

    this.setRemindersMap(map);
    return { imported, exported, updated };
  },
};
