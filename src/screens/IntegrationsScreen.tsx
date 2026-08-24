import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FieldGroup, ScreenHeader, BackButton, ErrorBanner, Icon } from "../components/UI";
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
} from "../api/integrations";
import { useTasks, useCreateTask, useUpdateTask } from "../api/tasks";
import { getErrorMessage } from "../lib/errors";

export function IntegrationsScreen() {
  const navigate = useNavigate();
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
  const [selectedRemListId, setSelectedRemListId] = useState<string>(() => {
    return localStorage.getItem("apple_reminders_list_id") || "";
  });

  const [appleSyncStatus, setAppleSyncStatus] = useState<string | null>(null);
  const [isAppleSyncing, setIsAppleSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Google Integration API
  const { data: intStatus, isLoading: isStatusLoading, refetch: refetchStatus } = useIntegrationsStatus();
  const { data: gListsData, isLoading: isGListsLoading } = useGoogleLists();
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

  const { data: allTasks = [] } = useTasks();
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();

  const handleSyncAppleReminders = async () => {
    setIsAppleSyncing(true);
    setError(null);
    try {
      const res = await AppleIntegrations.syncAllReminders(
        allTasks,
        createTask.mutateAsync,
        updateTask.mutateAsync,
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
    if (!confirm("Отключить Google Задачи?")) return;
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
        leading={<BackButton onClick={() => navigate(-1)} />}
        title="Интеграции"
      />

      <div className="px-4 space-y-6 max-w-lg mx-auto pt-2">
        <ErrorBanner error={error} variant="block" />

        {appleSyncStatus && (
          <div className="bg-card border border-teal/30 rounded-xl p-3 flex items-center gap-3 text-sm text-teal">
            <Icon name="check" size={18} className="shrink-0" />
            <span>{appleSyncStatus}</span>
          </div>
        )}

        {/* ═══════════ Apple Экосистема ═══════════ */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-sub px-1 mb-2">
            Apple Экосистема (iOS)
          </h2>

          <FieldGroup>
            {/* Apple Календарь */}
            <div className="p-4 bg-card border-b border-stroke/50">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center text-red-500">
                    <Icon name="calendar" size={18} />
                  </div>
                  <div>
                    <div className="text-[15px] font-medium text-text">Apple Календарь</div>
                    <div className="text-xs text-sub">
                      {isApple
                        ? calPerm.granted
                          ? "Доступ открыт (события видны в Предстоящем)"
                          : "Требуется разрешение"
                        : "Доступно на iPhone"}
                    </div>
                  </div>
                </div>

                {isApple && (
                  <div>
                    {calPerm.granted ? (
                      <span className="text-xs text-teal font-medium px-2 py-1 bg-teal/10 rounded-md">
                        Включён
                      </span>
                    ) : (
                      <button
                        onClick={handleRequestCalendar}
                        className="text-xs font-semibold px-3 py-1.5 bg-coral text-white rounded-lg active:scale-95 transition-transform"
                      >
                        Разрешить
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Выбор календарей */}
              {calPerm.granted && calendars.length > 0 && (
                <div className="mt-3 pt-3 border-t border-stroke/40 space-y-2">
                  <div className="text-xs font-medium text-sub">Отображать календари:</div>
                  <div className="space-y-1.5">
                    {calendars.map((cal) => {
                      const isChecked = selectedCalIds.includes(cal.id);
                      return (
                        <button
                          key={cal.id}
                          onClick={() => toggleCalendar(cal.id)}
                          className="w-full flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-card-hover transition-colors text-left"
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className="w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: cal.color }}
                            />
                            <span className="text-xs text-text">{cal.title}</span>
                          </div>
                          {isChecked && <Icon name="check" size={14} className="text-coral" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Apple Напоминания */}
            <div className="p-4 bg-card">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-orange-500/10 flex items-center justify-center text-orange-500">
                    <Icon name="calendar-check" size={18} />
                  </div>
                  <div>
                    <div className="text-[15px] font-medium text-text">Apple Напоминания</div>
                    <div className="text-xs text-sub">
                      {isApple
                        ? remPerm.granted
                          ? "Доступ открыт"
                          : "Требуется разрешение"
                        : "Доступно на iPhone"}
                    </div>
                  </div>
                </div>

                {isApple && (
                  <div>
                    {remPerm.granted ? (
                      <span className="text-xs text-teal font-medium px-2 py-1 bg-teal/10 rounded-md">
                        Включён
                      </span>
                    ) : (
                      <button
                        onClick={handleRequestReminders}
                        className="text-xs font-semibold px-3 py-1.5 bg-coral text-white rounded-lg active:scale-95 transition-transform"
                      >
                        Разрешить
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Настройки напоминаний */}
              {remPerm.granted && (
                <div className="mt-3 pt-3 border-t border-stroke/40 space-y-3">
                  {reminderLists.length > 0 && (
                    <div>
                      <label className="text-xs text-sub block mb-1">Список для синхронизации:</label>
                      <select
                        value={selectedRemListId}
                        onChange={(e) => {
                          setSelectedRemListId(e.target.value);
                          localStorage.setItem("apple_reminders_list_id", e.target.value);
                        }}
                        className="w-full bg-card border border-stroke rounded-lg px-3 py-2 text-xs text-text focus:outline-none focus:border-coral"
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
                    className="w-full py-2 bg-card border border-stroke rounded-lg text-xs font-medium text-text flex items-center justify-center gap-2 active:scale-98 transition-transform disabled:opacity-50"
                  >
                    <Icon
                      name="refresh-cw"
                      size={14}
                      className={isAppleSyncing ? "animate-spin text-coral" : "text-sub"}
                    />
                    <span>{isAppleSyncing ? "Синхронизация..." : "Синхронизировать напоминания"}</span>
                  </button>
                </div>
              )}
            </div>
          </FieldGroup>
        </div>

        {/* ═══════════ Google Задачи ═══════════ */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-sub px-1 mb-2">
            Google Задачи (Google Tasks)
          </h2>

          <FieldGroup>
            <div className="p-4 bg-card">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-500">
                    <Icon name="tag" size={18} />
                  </div>
                  <div>
                    <div className="text-[15px] font-medium text-text">Google Задачи</div>
                    <div className="text-xs text-sub">
                      {isStatusLoading
                        ? "Проверка..."
                        : googleConnected
                        ? intStatus?.google?.email || "Аккаунт подключён"
                        : "Синхронизация списков и задач"}
                    </div>
                  </div>
                </div>

                <div>
                  {googleConnected ? (
                    <button
                      onClick={handleDisconnectGoogle}
                      disabled={disconnectGoogle.isPending}
                      className="text-xs text-coral font-medium hover:underline"
                    >
                      Отключить
                    </button>
                  ) : (
                    <button
                      onClick={handleConnectGoogle}
                      disabled={getAuthUrl.isPending}
                      className="text-xs font-semibold px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg active:scale-95 transition-transform"
                    >
                      {getAuthUrl.isPending ? "..." : "Войти с Google"}
                    </button>
                  )}
                </div>
              </div>

              {/* Если Google подключен */}
              {googleConnected && (
                <div className="mt-3 pt-3 border-t border-stroke/40 space-y-3">
                  {isGListsLoading ? (
                    <div className="text-xs text-sub">Загрузка списков Google...</div>
                  ) : gListsData?.lists && gListsData.lists.length > 0 ? (
                    <div>
                      <label className="text-xs text-sub block mb-1">Список Google Tasks:</label>
                      <select
                        value={intStatus?.google?.settings?.listId || "@default"}
                        onChange={(e) => handleSelectGoogleList(e.target.value)}
                        className="w-full bg-card border border-stroke rounded-lg px-3 py-2 text-xs text-text focus:outline-none focus:border-coral"
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

                  <button
                    onClick={handleSyncGoogle}
                    disabled={googleSync.isPending}
                    className="w-full py-2 bg-card border border-stroke rounded-lg text-xs font-medium text-text flex items-center justify-center gap-2 active:scale-98 transition-transform disabled:opacity-50"
                  >
                    <Icon
                      name="refresh-cw"
                      size={14}
                      className={googleSync.isPending ? "animate-spin text-coral" : "text-sub"}
                    />
                    <span>{googleSync.isPending ? "Синхронизация..." : "Синхронизировать сейчас"}</span>
                  </button>

                  {intStatus?.google?.lastSyncedAt && (
                    <div className="text-[11px] text-dim text-center">
                      Последняя синхронизация: {new Date(intStatus.google.lastSyncedAt).toLocaleString("ru-RU")}
                    </div>
                  )}
                </div>
              )}
            </div>
          </FieldGroup>
        </div>
      </div>
    </div>
  );
}
