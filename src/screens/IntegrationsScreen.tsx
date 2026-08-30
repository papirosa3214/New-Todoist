import { useEffect, useState } from "react";

import { ScreenHeader, ErrorBanner, Icon } from "../components/UI";
import {
  AppleIntegrations,
  type CalendarInfo,
  type ReminderListInfo,
  type PermissionStatus,
} from "../lib/appleIntegrations";
import {
  useIntegrationsStatus,
  useGoogleAuthUrl,
  useGoogleLists,
  useGoogleSync,
  useDisconnectGoogle,
  useUpdateIntegrationSettings,
  useGoogleCallback,
  useGoogleCalendars,
} from "../api/integrations";
import { useTasks, useCreateTask, useUpdateTask } from "../api/tasks";
import { useProjects, useCreateProject } from "../api/projects";
import { getErrorMessage } from "../lib/errors";

export function IntegrationsScreen() {
  const [calPerm, setCalPerm] = useState<PermissionStatus>({ status: "notDetermined", granted: false });
  const [remPerm, setRemPerm] = useState<PermissionStatus>({ status: "notDetermined", granted: false });
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const [reminderLists, setReminderLists] = useState<ReminderListInfo[]>([]);
  const [selectedCalIds, setSelectedCalIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("apple_calendar_ids") || "[]");
    } catch {
      return [];
    }
  });
  const [selectedGoogleCalIds, setSelectedGoogleCalIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("google_calendar_ids") || "[]");
    } catch {
      return [];
    }
  });
  const [selectedRemListId, setSelectedRemListId] = useState<string>(() => {
    return localStorage.getItem("apple_reminders_list_id") || "";
  });

  // Состояние аккордеона (какая секция открыта)
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    appleCal: false,
    appleRem: false,
    googleTasks: true,
    googleCal: false,
  });

  const toggleSection = (key: string) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const [appleSyncStatus, setAppleSyncStatus] = useState<string | null>(null);
  const [isAppleSyncing, setIsAppleSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Google Integration API
  const { data: intStatus, isLoading: isStatusLoading, refetch: refetchStatus } = useIntegrationsStatus();
  const { data: gListsData, isLoading: isGListsLoading } = useGoogleLists();
  const { data: gCalsData, isLoading: isGCalsLoading } = useGoogleCalendars(!!intStatus?.google?.connected);
  const getAuthUrl = useGoogleAuthUrl();
  const googleCallback = useGoogleCallback();
  const googleSync = useGoogleSync();
  const disconnectGoogle = useDisconnectGoogle();
  const updateSettings = useUpdateIntegrationSettings();

  // Проверяем наличие OAuth code в URL при возврате с Google
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (code) {
      window.history.replaceState({}, document.title, window.location.pathname);
      googleCallback.mutate(
        { code, redirectUri: window.location.origin + window.location.pathname },
        {
          onSuccess: (res) => {
            refetchStatus();
            setAppleSyncStatus(`Google аккаунт ${res.email || ""} успешно подключён!`);
          },
          onError: (err) => {
            setError(`Ошибка подключения Google: ${getErrorMessage(err)}`);
          },
        },
      );
    }
  }, []);

  // Загрузка статусов Apple
  useEffect(() => {
    if (AppleIntegrations.isAvailable()) {
      AppleIntegrations.getCalendarStatus().then((s) => {
        setCalPerm(s);
        if (s.granted) {
          AppleIntegrations.getCalendars().then(setCalendars);
        }
      });
      AppleIntegrations.getRemindersStatus().then((s) => {
        setRemPerm(s);
        if (s.granted) {
          AppleIntegrations.getReminderLists().then((lists) => {
            setReminderLists(lists);
            if (!selectedRemListId && lists.length > 0) {
              const def = lists.find((l) => l.isDefault) || lists[0];
              setSelectedRemListId(def.id);
              localStorage.setItem("apple_reminders_list_id", def.id);
            }
          });
        }
      });
    }
  }, []);

  const handleRequestCalendar = async () => {
    setError(null);
    const granted = await AppleIntegrations.requestCalendarAccess();
    const status = await AppleIntegrations.getCalendarStatus();
    setCalPerm(status);
    if (granted) {
      const cals = await AppleIntegrations.getCalendars();
      setCalendars(cals);
      const allIds = cals.map((c) => c.id);
      setSelectedCalIds(allIds);
      localStorage.setItem("apple_calendar_ids", JSON.stringify(allIds));
    }
  };

  const handleRequestReminders = async () => {
    setError(null);
    const granted = await AppleIntegrations.requestRemindersAccess();
    const status = await AppleIntegrations.getRemindersStatus();
    setRemPerm(status);
    if (granted) {
      const lists = await AppleIntegrations.getReminderLists();
      setReminderLists(lists);
      if (lists.length > 0) {
        const def = lists.find((l) => l.isDefault) || lists[0];
        setSelectedRemListId(def.id);
        localStorage.setItem("apple_reminders_list_id", def.id);
      }
    }
  };

  const toggleCalendar = (id: string) => {
    const updated = selectedCalIds.includes(id)
      ? selectedCalIds.filter((cid) => cid !== id)
      : [...selectedCalIds, id];
    setSelectedCalIds(updated);
    localStorage.setItem("apple_calendar_ids", JSON.stringify(updated));
  };

  const toggleGoogleCalendar = (id: string) => {
    const updated = selectedGoogleCalIds.includes(id)
      ? selectedGoogleCalIds.filter((cid) => cid !== id)
      : [...selectedGoogleCalIds, id];
    setSelectedGoogleCalIds(updated);
    localStorage.setItem("google_calendar_ids", JSON.stringify(updated));
  };

  const { data: allTasks = [] } = useTasks();
  const { data: projects = [] } = useProjects();
  const createProject = useCreateProject();
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();

  const handleSyncAppleReminders = async () => {
    setIsAppleSyncing(true);
    setError(null);
    try {
      let appleProjectId: string | undefined = projects.find(
        (p) => p.name === "Apple Напоминания",
      )?.id;

      if (!appleProjectId) {
        try {
          const created = await createProject.mutateAsync({
            name: "Apple Напоминания",
            color: "#FF9500",
          });
          appleProjectId = created.id;
        } catch {
          // ignore
        }
      }

      const res = await AppleIntegrations.syncAllReminders(
        allTasks,
        createTask.mutateAsync,
        updateTask.mutateAsync,
        appleProjectId,
      );
      setAppleSyncStatus(
        `Синхронизация Apple Напоминаний: добавлено в TaskFlow: ${res.imported}, отправлено в Apple: ${res.exported}, обновлено: ${res.updated}`,
      );
    } catch (err) {
      setError(`Ошибка синхронизации напоминаний: ${getErrorMessage(err)}`);
    } finally {
      setIsAppleSyncing(false);
    }
  };

  const handleConnectGoogle = () => {
    setError(null);
    const redirectUri = window.location.origin + window.location.pathname;
    getAuthUrl.mutate(
      { redirectUri },
      {
        onSuccess: (data) => {
          if (data.url) {
            window.location.href = data.url;
          }
        },
        onError: (err) => {
          setError(`Не удалось сформировать ссылку Google: ${getErrorMessage(err)}`);
        },
      },
    );
  };

  const handleDisconnectGoogle = () => {
    if (!confirm("Отключить Google аккаунт?")) return;
    disconnectGoogle.mutate(undefined, {
      onSuccess: () => {
        refetchStatus();
      },
    });
  };

  const handleSyncGoogle = () => {
    setError(null);
    googleSync.mutate(
      { listId: intStatus?.google?.settings?.listId || "@default" },
      {
        onSuccess: (data) => {
          setAppleSyncStatus(
            `Google Задачи: импортировано ${data.imported}, обновлено ${data.updated} (всего ${data.totalGoogleTasks})`,
          );
        },
        onError: (err) => {
          setError(`Ошибка синхронизации Google: ${getErrorMessage(err)}`);
        },
      },
    );
  };

  const handleSelectGoogleList = (listId: string) => {
    updateSettings.mutate({
      provider: "google",
      settings: { ...intStatus?.google?.settings, listId },
    });
  };

  const isApple = AppleIntegrations.isAvailable();
  const googleConnected = intStatus?.google?.connected;

  return (
    <div className="min-h-screen bg-bg text-text pb-12">
      <ScreenHeader
        variant="compact"
        title="Интеграции"
      />

      <div className="px-4 space-y-4 max-w-lg mx-auto pt-2">
        <ErrorBanner error={error} variant="block" />

        {appleSyncStatus && (
          <div className="bg-card border border-teal/30 rounded-xl p-3 flex items-center gap-3 text-sm text-teal">
            <Icon name="check" size={18} className="shrink-0" />
            <span>{appleSyncStatus}</span>
          </div>
        )}

        {/* ═══════════ СЕКЦИЯ: APPLE ЭКОСИСТЕМА ═══════════ */}
        <div className="space-y-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-sub px-1">
            Apple Экосистема (iOS)
          </div>

          {/* 1. Аккордеон: Apple Календарь */}
          <div className="bg-card border border-stroke/50 rounded-2xl overflow-hidden shadow-xs">
            <button
              onClick={() => toggleSection("appleCal")}
              className="w-full p-4 flex items-center justify-between text-left hover:bg-card-hover/40 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-xl bg-red-500/10 flex items-center justify-center text-red-500 shrink-0">
                  <Icon name="calendar" size={18} />
                </div>
                <div className="min-w-0">
                  <div className="text-[15px] font-medium text-text">Apple Календарь</div>
                  <div className="text-xs text-sub truncate">
                    {isApple
                      ? calPerm.granted
                        ? calendars.length > 0
                          ? `Выбрано: ${selectedCalIds.length || "все"} из ${calendars.length}`
                          : "Доступ открыт"
                        : "Требуется разрешение"
                      : "Доступно на iPhone"}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {isApple && calPerm.granted && (
                  <span className="text-[11px] text-teal font-medium px-2 py-0.5 bg-teal/10 rounded-md">
                    Включён
                  </span>
                )}
                <Icon
                  name={openSections.appleCal ? "chevron-up" : "chevron-down"}
                  size={16}
                  className="text-sub"
                />
              </div>
            </button>

            {openSections.appleCal && (
              <div className="px-4 pb-4 pt-1 border-t border-stroke/40 space-y-3 bg-card2/30">
                {!calPerm.granted ? (
                  <div className="pt-2">
                    <button
                      onClick={handleRequestCalendar}
                      className="w-full py-2 bg-coral text-white rounded-xl text-xs font-semibold active:scale-98 transition-transform"
                    >
                      Разрешить доступ к Apple Календарю
                    </button>
                  </div>
                ) : calendars.length > 0 ? (
                  <div className="pt-2 space-y-2">
                    <div className="text-xs font-medium text-sub">Отображать календари в расписании:</div>
                    <div className="space-y-1 bg-card rounded-xl p-2 border border-stroke/40">
                      {calendars.map((cal) => {
                        const isChecked =
                          selectedCalIds.length === 0 || selectedCalIds.includes(cal.id);
                        return (
                          <button
                            key={cal.id}
                            onClick={() => toggleCalendar(cal.id)}
                            className="w-full flex items-center justify-between py-1.5 px-2.5 rounded-lg hover:bg-card-hover transition-colors text-left"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className="w-2.5 h-2.5 rounded-full shrink-0"
                                style={{ backgroundColor: cal.color }}
                              />
                              <span className="text-xs text-text truncate">{cal.title}</span>
                            </div>
                            {isChecked && (
                              <Icon name="check" size={14} className="text-coral shrink-0 ml-2" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-sub pt-2">Календари не найдены</div>
                )}
              </div>
            )}
          </div>

          {/* 2. Аккордеон: Apple Напоминания */}
          <div className="bg-card border border-stroke/50 rounded-2xl overflow-hidden shadow-xs">
            <button
              onClick={() => toggleSection("appleRem")}
              className="w-full p-4 flex items-center justify-between text-left hover:bg-card-hover/40 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-xl bg-orange-500/10 flex items-center justify-center text-orange-500 shrink-0">
                  <Icon name="calendar-check" size={18} />
                </div>
                <div className="min-w-0">
                  <div className="text-[15px] font-medium text-text">Apple Напоминания</div>
                  <div className="text-xs text-sub truncate">
                    {isApple
                      ? remPerm.granted
                        ? "Двусторонняя синхронизация задач"
                        : "Требуется разрешение"
                      : "Доступно на iPhone"}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {isApple && remPerm.granted && (
                  <span className="text-[11px] text-teal font-medium px-2 py-0.5 bg-teal/10 rounded-md">
                    Включён
                  </span>
                )}
                <Icon
                  name={openSections.appleRem ? "chevron-up" : "chevron-down"}
                  size={16}
                  className="text-sub"
                />
              </div>
            </button>

            {openSections.appleRem && (
              <div className="px-4 pb-4 pt-1 border-t border-stroke/40 space-y-3 bg-card2/30">
                {!remPerm.granted ? (
                  <div className="pt-2">
                    <button
                      onClick={handleRequestReminders}
                      className="w-full py-2 bg-coral text-white rounded-xl text-xs font-semibold active:scale-98 transition-transform"
                    >
                      Разрешить доступ к Apple Напоминаниям
                    </button>
                  </div>
                ) : (
                  <div className="pt-2 space-y-3">
                    {reminderLists.length > 0 && (
                      <div>
                        <label className="text-xs text-sub block mb-1">Список Apple Напоминаний:</label>
                        <select
                          value={selectedRemListId}
                          onChange={(e) => {
                            setSelectedRemListId(e.target.value);
                            localStorage.setItem("apple_reminders_list_id", e.target.value);
                          }}
                          className="w-full bg-card border border-stroke rounded-xl px-3 py-2 text-xs text-text focus:outline-none focus:border-coral"
                        >
                          {reminderLists.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.title} {l.isDefault ? "(по умолчанию)" : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    <button
                      onClick={handleSyncAppleReminders}
                      disabled={isAppleSyncing}
                      className="w-full py-2.5 bg-card border border-stroke rounded-xl text-xs font-medium text-text flex items-center justify-center gap-2 active:scale-98 transition-transform disabled:opacity-50 shadow-2xs"
                    >
                      <Icon
                        name="refresh-cw"
                        size={14}
                        className={isAppleSyncing ? "animate-spin text-coral" : "text-sub"}
                      />
                      <span>{isAppleSyncing ? "Синхронизация..." : "Синхронизировать сейчас"}</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ═══════════ СЕКЦИЯ: GOOGLE СЕРВИСЫ ═══════════ */}
        <div className="space-y-3 pt-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-sub px-1">
            Google Сервисы
          </div>

          {/* 3. Аккордеон: Google Задачи */}
          <div className="bg-card border border-stroke/50 rounded-2xl overflow-hidden shadow-xs">
            <button
              onClick={() => toggleSection("googleTasks")}
              className="w-full p-4 flex items-center justify-between text-left hover:bg-card-hover/40 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-xl bg-blue-500/10 flex items-center justify-center text-blue-500 shrink-0">
                  <Icon name="tag" size={18} />
                </div>
                <div className="min-w-0">
                  <div className="text-[15px] font-medium text-text">Google Задачи</div>
                  <div className="text-xs text-sub truncate">
                    {isStatusLoading
                      ? "Проверка..."
                      : googleConnected
                      ? intStatus?.google?.email || "Аккаунт подключён"
                      : "Импорт задач и списков"}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {googleConnected && (
                  <span className="text-[11px] text-teal font-medium px-2 py-0.5 bg-teal/10 rounded-md">
                    В сети
                  </span>
                )}
                <Icon
                  name={openSections.googleTasks ? "chevron-up" : "chevron-down"}
                  size={16}
                  className="text-sub"
                />
              </div>
            </button>

            {openSections.googleTasks && (
              <div className="px-4 pb-4 pt-1 border-t border-stroke/40 space-y-3 bg-card2/30">
                {!googleConnected ? (
                  <div className="pt-2">
                    <button
                      onClick={handleConnectGoogle}
                      disabled={getAuthUrl.isPending}
                      className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-semibold active:scale-98 transition-transform shadow-2xs"
                    >
                      {getAuthUrl.isPending ? "Формирование ссылки..." : "Войти через Google"}
                    </button>
                  </div>
                ) : (
                  <div className="pt-2 space-y-3">
                    {isGListsLoading ? (
                      <div className="text-xs text-sub">Загрузка списков задач...</div>
                    ) : gListsData?.lists && gListsData.lists.length > 0 ? (
                      <div>
                        <label className="text-xs text-sub block mb-1">Список Google Tasks:</label>
                        <select
                          value={intStatus?.google?.settings?.listId || "@default"}
                          onChange={(e) => handleSelectGoogleList(e.target.value)}
                          className="w-full bg-card border border-stroke rounded-xl px-3 py-2 text-xs text-text focus:outline-none focus:border-coral"
                        >
                          <option value="@default">Основной список (@default)</option>
                          {gListsData.lists.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.title}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}

                    <div className="flex gap-2">
                      <button
                        onClick={handleSyncGoogle}
                        disabled={googleSync.isPending}
                        className="flex-1 py-2.5 bg-card border border-stroke rounded-xl text-xs font-medium text-text flex items-center justify-center gap-2 active:scale-98 transition-transform disabled:opacity-50 shadow-2xs"
                      >
                        <Icon
                          name="refresh-cw"
                          size={14}
                          className={googleSync.isPending ? "animate-spin text-coral" : "text-sub"}
                        />
                        <span>{googleSync.isPending ? "Синхронизация..." : "Синхронизировать"}</span>
                      </button>

                      <button
                        onClick={handleDisconnectGoogle}
                        disabled={disconnectGoogle.isPending}
                        className="px-3 py-2.5 bg-card border border-stroke rounded-xl text-xs text-coral font-medium active:scale-98 transition-transform hover:bg-red-500/10"
                      >
                        Отключить
                      </button>
                    </div>

                    {intStatus?.google?.lastSyncedAt && (
                      <div className="text-[11px] text-dim text-center">
                        Последняя синхронизация: {new Date(intStatus.google.lastSyncedAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 4. Аккордеон: Google Календарь */}
          <div className="bg-card border border-stroke/50 rounded-2xl overflow-hidden shadow-xs">
            <button
              onClick={() => toggleSection("googleCal")}
              className="w-full p-4 flex items-center justify-between text-left hover:bg-card-hover/40 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-xl bg-blue-600/10 flex items-center justify-center text-blue-600 shrink-0">
                  <Icon name="calendar" size={18} />
                </div>
                <div className="min-w-0">
                  <div className="text-[15px] font-medium text-text">Google Календарь</div>
                  <div className="text-xs text-sub truncate">
                    {googleConnected
                      ? gCalsData?.calendars && gCalsData.calendars.length > 0
                        ? `Выбрано: ${selectedGoogleCalIds.length || "все"} из ${gCalsData.calendars.length}`
                        : "События в Предстоящем и Сегодня"
                      : "Требуется вход с Google"}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {googleConnected && (
                  <span className="text-[11px] text-teal font-medium px-2 py-0.5 bg-teal/10 rounded-md">
                    В сети
                  </span>
                )}
                <Icon
                  name={openSections.googleCal ? "chevron-up" : "chevron-down"}
                  size={16}
                  className="text-sub"
                />
              </div>
            </button>

            {openSections.googleCal && (
              <div className="px-4 pb-4 pt-1 border-t border-stroke/40 space-y-3 bg-card2/30">
                {!googleConnected ? (
                  <div className="pt-2">
                    <button
                      onClick={handleConnectGoogle}
                      disabled={getAuthUrl.isPending}
                      className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-semibold active:scale-98 transition-transform shadow-2xs"
                    >
                      {getAuthUrl.isPending ? "Формирование ссылки..." : "Войти через Google"}
                    </button>
                  </div>
                ) : (
                  <div className="pt-2 space-y-2">
                    {isGCalsLoading ? (
                      <div className="text-xs text-sub">Загрузка календарей Google...</div>
                    ) : gCalsData?.calendars && gCalsData.calendars.length > 0 ? (
                      <>
                        <div className="text-xs font-medium text-sub">Отображать календари Google:</div>
                        <div className="space-y-1 bg-card rounded-xl p-2 border border-stroke/40">
                          {gCalsData.calendars.map((cal) => {
                            const isChecked =
                              selectedGoogleCalIds.length === 0 ||
                              selectedGoogleCalIds.includes(cal.id);
                            return (
                              <button
                                key={cal.id}
                                onClick={() => toggleGoogleCalendar(cal.id)}
                                className="w-full flex items-center justify-between py-1.5 px-2.5 rounded-lg hover:bg-card-hover transition-colors text-left"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <span
                                    className="w-2.5 h-2.5 rounded-full shrink-0"
                                    style={{ backgroundColor: cal.backgroundColor || "#4285F4" }}
                                  />
                                  <span className="text-xs text-text truncate">
                                    {cal.summary} {cal.primary ? "(Основной)" : ""}
                                  </span>
                                </div>
                                {isChecked && (
                                  <Icon name="check" size={14} className="text-blue-500 shrink-0 ml-2" />
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </>
                    ) : (
                      <div className="text-xs text-sub">Календари не найдены или нет доступа</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
