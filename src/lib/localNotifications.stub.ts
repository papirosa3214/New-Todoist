// Заглушка @capacitor/local-notifications.
//
// Пакет не установлен в web-сборке (уведомления шлёт нативная оболочка), но
// useTaskActivity.ts импортирует его статически — из-за этого падал и
// `npm test` (не мог разрешить модуль), и tsc. Vite-алиас (vite.config.ts)
// и tsconfig paths направляют сюда и рантайм, и типы.
export interface LocalNotificationPermissionStatus {
  display: "granted" | "denied" | "prompt" | "prompt-with-rationale";
}

export interface LocalNotificationSchema {
  title?: string;
  body?: string;
  id?: number;
}

export const LocalNotifications = {
  async requestPermissions(): Promise<LocalNotificationPermissionStatus> {
    return { display: "denied" };
  },
  async schedule(_options: {
    notifications: LocalNotificationSchema[];
  }): Promise<{ notifications: unknown[] }> {
    return { notifications: [] };
  },
};

export default { LocalNotifications };
