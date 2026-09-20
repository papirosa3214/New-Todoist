import { useNavigate } from "react-router-dom";
import { useRef, useState, useEffect } from "react";
import {
  FieldGroup,
  Icon,
  ScreenHeader,
  ErrorBanner,
  Avatar,
} from "../components/UI";
import { useCurrentUser, useLogout } from "../api/auth";
import { useServerStatus } from "../api/server";
import {
  useAgentService,
  useSetReviewerFirstDefault,
  useSetTaskIntakeMode,
  useTaskIntakeSettings,
  useToggleAgentService,
} from "../api/agents";
import { useUploadAvatar, useDeleteAvatar } from "../api/avatars";
import { getErrorMessage } from "../lib/errors";
import { useAppStore } from "../store";
import { Biometrics } from "../lib/biometrics";
import { EditProfileModal } from "../components/EditProfileModal";

interface RowProps {
  icon: string;
  iconColor?: string;
  label: string;
  value?: string;
  onClick?: () => void;
  danger?: boolean;
}

function Row({
  icon,
  iconColor = "#FF6B6B",
  label,
  value,
  onClick,
  danger,
}: RowProps) {
  return (
    // tap-row — строка внутри карточки, ровно тот случай, под который класс
    // и заведён (см. описание системы откликов в index.css). Без него все
    // семь строк этого экрана нажимались вообще без видимой реакции:
    // глобальный -webkit-tap-highlight-color: transparent снял системную
    // подсветку, а замены строкам не дали.
    <button
      onClick={onClick}
      className="tap-row w-full flex items-center gap-3 py-3 px-4 bg-card text-left"
    >
      <div
        className="w-[28px] h-[28px] rounded-lg flex items-center justify-center shrink-0"
        style={{ backgroundColor: iconColor + "18" }}
      >
        <Icon
          name={icon}
          size={16}
          className={danger ? "text-coral" : "text-text"}
        />
      </div>
      <span
        className={`text-[15px] flex-1 ${danger ? "text-coral" : "text-text"}`}
      >
        {label}
      </span>
      {value && <span className="text-[13px] text-sub">{value}</span>}
      {!danger && <Icon name="chevron" size={16} className="text-dim" />}
    </button>
  );
}

interface InfoRowProps {
  icon: string;
  iconColor?: string;
  label: string;
  value: string;
}

function InfoRow({ icon, iconColor = "#FF6B6B", label, value }: InfoRowProps) {
  return (
    <div className="w-full flex items-center gap-3 py-3 px-4 bg-card text-left">
      <div
        className="w-[28px] h-[28px] rounded-lg flex items-center justify-center shrink-0"
        style={{ backgroundColor: iconColor + "18" }}
      >
        <Icon name={icon} size={16} className="text-text" />
      </div>
      <span className="text-[15px] flex-1 text-text">{label}</span>
      <span className="text-[13px] text-sub">{value}</span>
    </div>
  );
}

// Геометрия скопирована буквально из mockup-reference/index.html's `.switch`
// (43×25px pill, 20px белый кружок, тень 0 1px 3px rgba(0,0,0,.3)) — там
// это статичный, всегда «включённый» (красный) макет одного состояния;
// здесь добавлено настоящее выключенное состояние (серый фон, кружок
// слева), которого в референсе просто нет ни одного примера.
function Switch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onChange}
      // Сам переключатель остаётся 43×25 (геометрия снята с макета), а зона
      // нажатия доведена до 44×44 прозрачным ::before по центру — замер
      // показал 43×25, то есть по высоте почти вдвое меньше нормы HIG.
      className={`tap-scale relative w-[43px] h-[25px] rounded-full shrink-0 transition-colors before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] ${
        checked ? "bg-red" : "bg-card2 border border-stroke"
      }`}
    >
      <span
        className="absolute top-[2.5px] w-[20px] h-[20px] rounded-full bg-white shadow-toggle transition-[right] duration-150"
        style={{ right: checked ? "2.5px" : "20.5px" }}
      />
    </button>
  );
}

interface ToggleRowProps {
  icon: string;
  iconColor?: string;
  label: string;
  valueLabel?: string;
  checked: boolean;
  onChange: () => void;
}

// Единственный реальный переключатель на этом экране (тема) — остальные
// строки либо ссылки (Row), либо статичный текст (InfoRow, «Иконка»: одна
// фиксированная иконка приложения, менять нечего).
function ToggleRow({
  icon,
  iconColor = "#FF6B6B",
  label,
  valueLabel,
  checked,
  onChange,
}: ToggleRowProps) {
  return (
    <div className="w-full flex items-center gap-3 py-3 px-4 bg-card text-left">
      <div
        className="w-[28px] h-[28px] rounded-lg flex items-center justify-center shrink-0"
        style={{ backgroundColor: iconColor + "18" }}
      >
        <Icon name={icon} size={16} className="text-text" />
      </div>
      <span className="text-[15px] flex-1 text-text">{label}</span>
      {valueLabel && <span className="text-[13px] text-sub">{valueLabel}</span>}
      <Switch checked={checked} onChange={onChange} ariaLabel={label} />
    </div>
  );
}

// Аватарка своего аккаунта — картинка вместо инициалов+цвета (просьба
// Максима 17.08.2026: «через настройки, где я указан, нативно выбирать
// аватарку»). Тап по кружку открывает системный выбор файла; крестик
// поверх — только когда картинка уже стоит, убирает её обратно на
// инициалы+цвет. PNG/JPEG/WebP/GIF/SVG — то же ограничение, что и на
// сервере (routes/avatars.ts), тут только чтобы браузер не открыл
// диалог выбора вообще всего подряд.
function AccountAvatarRow({
  userId,
  name,
  email,
  initials,
  color,
  avatarUrl,
  onEdit,
}: {
  userId: string;
  name: string;
  email?: string;
  initials?: string;
  color?: string;
  avatarUrl?: string | null;
  onEdit?: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = useUploadAvatar(userId);
  const del = useDeleteAvatar(userId);
  const [error, setError] = useState<string | null>(null);
  const busy = upload.isPending || del.isPending;

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // тот же файл повторно тоже должен триггерить change
    if (!file) return;
    setError(null);
    upload.mutate(file, {
      onError: (err) => setError(getErrorMessage(err)),
    });
  }

  return (
    <div className="w-full flex items-center gap-3 py-3 px-4 bg-card">
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        aria-label="Сменить аватарку"
        // Кружок 40×40, зона — 44×44 (те же 2pt по кругу, что у кнопок
        // скрепки и отправки в карточке задачи).
        className="relative shrink-0 tap-scale before:absolute before:-inset-[2px] before:content-['']"
      >
        <Avatar
          initials={initials}
          color={color}
          avatar_url={avatarUrl}
          size={40}
        />
        <span className="absolute inset-0 rounded-full bg-black/0 hover:bg-black/30 transition-colors flex items-center justify-center">
          <Icon
            name="image"
            size={14}
            className="text-white opacity-0 hover:opacity-100"
          />
        </span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        className="hidden"
        onChange={onPick}
      />
      <div className="flex-1 min-w-0 cursor-pointer" onClick={onEdit}>
        <div className="text-[15px] text-text font-medium truncate flex items-center gap-1.5">
          {name}
        </div>
        {email && <div className="text-[13px] text-sub truncate">{email}</div>}
        {error && <div className="text-[12px] text-coral mt-0.5">{error}</div>}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="tap-fade py-1 px-2.5 rounded-lg bg-card2 border border-stroke text-[12px] text-text font-medium"
          >
            Изменить
          </button>
        )}
        {avatarUrl && (
          <button
            type="button"
            onClick={() => del.mutate()}
            disabled={busy}
            aria-label="Убрать аватарку"
            className="tap-fade text-[12px] text-sub"
          >
            Убрать фото
          </button>
        )}
      </div>
    </div>
  );
}

/** «2 ч 15 мин», «3 дня» — человеку, а не 8127 секунд. */
function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec} с`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} мин`;
  const hours = Math.floor(min / 60);
  if (hours < 24) {
    const rest = min % 60;
    return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} д ${restHours} ч` : `${days} д`;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

/** Состояние сервера — блок в настройках.
 *
 * Показываем ровно то, по чему видно живость и свежесть: работает ли,
 * сколько уже, на каком коде, велика ли база, идёт ли будильник. Никаких
 * технических дампов: владелец смотрит это с телефона и должен за две
 * секунды понять «всё в порядке» или «вот что не так».
 */
function ServerSection() {
  const { data, isLoading, error, refetch } = useServerStatus();
  const localOllamaModel = useAppStore((s) => s.localOllamaModel);
  const { data: service } = useAgentService();
  const toggleService = useToggleAgentService();
  const { data: intake } = useTaskIntakeSettings();
  const setReviewer = useSetReviewerFirstDefault();
  const setMode = useSetTaskIntakeMode();
  const serviceOn = service?.active ?? false;
  // Расписание — отдельная лампа: планировщик живёт независимо от службы и
  // делает запуск по времени и отложенные повторы. Словами «работает /
  // не работает» не пишем — это показывает цвет иконки, как лампа; в подписи
  // остаётся только последний обход.
  const sched = service?.scheduler;
  const schedLastRun = sched?.last_run_at
    ? new Date(sched.last_run_at).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const schedLamp = (() => {
    if (!sched || !sched.active) return "#8E8E93";
    if (!sched.last_run_at) return "#34C759";
    const mins = Math.round(
      (Date.now() - new Date(sched.last_run_at).getTime()) / 60000,
    );
    return mins > 15 ? "#FF6B6B" : "#34C759";
  })();
  // Состояние службы опрашивается раз в 15 секунд, а обратный отсчёт должен
  // идти ровно — поэтому тикаем сами, не дёргая сервер чаще.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!serviceOn || !service?.next_scan_at) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [serviceOn, service?.next_scan_at]);
  // «через 2:14» до ближайшего обхода доски. Пока отсчёт ушёл в минус —
  // обход уже идёт, но состояние ещё не переспросили: показываем «сейчас»,
  // а не отрицательное время.
  const nextScanLabel = (() => {
    if (!serviceOn || !service?.next_scan_at) return null;
    const left = Math.round(
      (new Date(service.next_scan_at).getTime() - now) / 1000,
    );
    if (left <= 0) return "обход сейчас";
    const mm = Math.floor(left / 60);
    const ss = String(left % 60).padStart(2, "0");
    return `обход через ${mm}:${ss}`;
  })();
  const [pingResult, setPingResult] = useState<string | null>(null);
  const [isPinging, setIsPinging] = useState(false);

  const handlePing = async () => {
    setIsPinging(true);
    const start = performance.now();
    try {
      const res = await refetch();
      const elapsed = Math.round(performance.now() - start);
      if (res.data?.ok) {
        setPingResult(`⚡ ${elapsed} мс · 192.168.1.110 в сети`);
      } else {
        setPingResult(`❌ Ошибка ответа`);
      }
    } catch {
      setPingResult(`❌ Сервер недоступен`);
    } finally {
      setIsPinging(false);
    }
  };

  // Сервер не ответил
  if (error) {
    return (
      <FieldGroup>
        <InfoRow
          icon="x"
          iconColor="#FF6B6B"
          label="Сервер 192.168.1.110"
          value="не отвечает 🔴"
        />
        <Row
          icon="activity"
          iconColor="#FF9500"
          label="Повторить проверку"
          onClick={handlePing}
        />
      </FieldGroup>
    );
  }
  if (isLoading || !data) {
    return (
      <FieldGroup>
        <InfoRow
          icon="activity"
          label="Сервер 192.168.1.110"
          value="проверяю связь…"
        />
      </FieldGroup>
    );
  }

  return (
    <FieldGroup>
      <InfoRow
        icon="activity"
        iconColor="#34C759"
        label="Сервер (192.168.1.110)"
        value={`В сети 🟢 · ${fmtUptime(data.uptime_sec)}`}
      />
      <InfoRow
        icon="bot"
        iconColor={data.ollama_online ? "#34C759" : "#FF6B6B"}
        label="Локальная LLM (Ollama)"
        value={
          data.ollama_online
            ? `${localOllamaModel.replace(":latest", "")} в сети 🟢`
            : "Недоступна 🔴"
        }
      />
      <Row
        icon="zap"
        iconColor="#0A84FF"
        label="Пинг"
        value={pingResult || (isPinging ? "Замеряю…" : "Проверить")}
        onClick={handlePing}
      />
      {data.commit && (
        <InfoRow
          icon="tag"
          iconColor="#4a9fd8"
          label="Версия"
          value={
            data.commit_at
              ? `${data.commit} · ${new Date(data.commit_at).toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "Europe/Moscow" })}`
              : data.commit
          }
        />
      )}
      <ToggleRow
        icon="power"
        iconColor="#FF6B6B"
        label="Система"
        valueLabel={serviceOn ? (nextScanLabel ?? undefined) : undefined}
        checked={serviceOn}
        onChange={() => toggleService.mutate(!serviceOn)}
      />
      <ToggleRow
        icon="sliders"
        iconColor="#FF9500"
        label="Автоодобрение задачи"
        checked={intake?.mode === "automatic"}
        onChange={() =>
          setMode.mutate(intake?.mode === "automatic" ? "manual" : "automatic")
        }
      />
      <ToggleRow
        icon="check"
        iconColor="#4a9fd8"
        label="Авторевьюер"
        checked={intake?.reviewer_first_default ?? true}
        onChange={() => setReviewer.mutate(!(intake?.reviewer_first_default ?? true))}
      />
      <InfoRow
        icon="clock"
        iconColor={schedLamp}
        label="Расписание"
        value={schedLastRun ? `Последний обход ${schedLastRun}` : "—"}
      />
      <InfoRow
        icon="list"
        iconColor="#9B8AFB"
        label="Задачи"
        value={
          data.db_bytes
            ? `${data.tasks_active} из ${data.tasks_total} · ${fmtBytes(data.db_bytes)}`
            : `${data.tasks_active} из ${data.tasks_total}`
        }
      />
    </FieldGroup>
  );
}

export function SettingsScreen() {
  const navigate = useNavigate();
  const { data: user, error } = useCurrentUser();
  const logout = useLogout();
  const theme = useAppStore((s) => s.settings.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioType, setBioType] = useState<string>("none");
  const [faceIdEnabled, setFaceIdEnabled] = useState(() =>
    Biometrics.isEnabled(),
  );

  const [isEditProfileOpen, setIsEditProfileOpen] = useState(false);

  useEffect(() => {
    Biometrics.isAvailable().then((info) => {
      setBioAvailable(info.available);
      setBioType(info.biometryType);
    });
  }, []);

  return (
    <div className="px-4 pb-4">
      <ScreenHeader title="Настройки" />

      <ErrorBanner
        error={error}
        fallback="Не удалось загрузить профиль"
        variant="block"
      />

      {/* Account section */}
      <div className="mb-4">
        <FieldGroup>
          {user ? (
            <AccountAvatarRow
              userId={user.id}
              name={user.name}
              email={user.email}
              initials={user.initials}
              color={user.avatar_color}
              avatarUrl={user.avatar_url}
              onEdit={() => setIsEditProfileOpen(true)}
            />
          ) : (
            <Row icon="person" label="Аккаунт" />
          )}
        </FieldGroup>
      </div>

      {user && (
        <EditProfileModal
          user={user}
          isOpen={isEditProfileOpen}
          onClose={() => setIsEditProfileOpen(false)}
        />
      )}

      {/* User settings */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">
        Пользовательские настройки
      </div>
      <div className="mb-4">
        <FieldGroup>
          <ToggleRow
            icon="moon"
            label="Тема"
            valueLabel={theme === "dark" ? "Тёмная" : "Светлая"}
            checked={theme === "dark"}
            onChange={() => setTheme(theme === "dark" ? "light" : "dark")}
          />
          {(bioAvailable ||
            (typeof window !== "undefined" &&
              !!(window as any).Capacitor?.isNativePlatform?.())) && (
            <ToggleRow
              icon="shield"
              iconColor="#34C759"
              label={
                bioType === "touchId" ? "Вход по Touch ID" : "Вход по Face ID"
              }
              valueLabel={faceIdEnabled ? "Включён" : "Выключен"}
              checked={faceIdEnabled}
              onChange={() => {
                const next = !faceIdEnabled;
                setFaceIdEnabled(next);
                Biometrics.setEnabled(next);
              }}
            />
          )}
          <InfoRow
            icon="image"
            iconColor="#FF2D55"
            label="Иконка"
            value="Pure Minimal Glass"
          />
        </FieldGroup>
      </div>

      {/* AI — ВЕСЬ в одном разделе (Максим 26.08.2026: «уже нагородили —
          мозг в одном месте, модели в другом, Ollama в третьем»). Одна
          строка-вход, всё внутри: /settings/voice-models. */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">
        Искусственный интеллект
      </div>
      <div className="mb-4">
        <FieldGroup>
          <Row
            icon="sparkles"
            iconColor="#AF52DE"
            label="Искусственный интеллект"
            onClick={() => navigate("/settings/voice-models")}
          />
        </FieldGroup>
      </div>

      {/* General */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">Общие</div>
      <div className="mb-4">
        <FieldGroup>
          {/* Строки «Проекты» здесь больше нет (26.08.2026): проекты стали
              пунктом веера, а Настройки — сами по себе строка в «Обзоре».
              Держать вход и там, и там значило бы вести к одному экрану
              двумя путями, причём этот был длиннее: Обзор → Настройки →
              Проекты. */}
          <Row
            icon="bookmark"
            iconColor="#FF9500"
            label="Шаблоны задач"
            onClick={() => navigate("/settings/templates")}
          />
          <Row icon="tag" label="Метки" onClick={() => navigate("/labels")} />
          <Row icon="bot" label="Команда" onClick={() => navigate("/agents")} />
          <Row
            icon="share"
            iconColor="#34C759"
            label="Интеграции (Google, Apple)"
            onClick={() => navigate("/settings/integrations")}
          />
          <Row
            icon="key"
            iconColor="#8B5CF6"
            label="Провайдеры LLM"
            onClick={() => navigate("/settings/providers")}
          />
          <Row
            icon="cpu"
            iconColor="#0EA5E9"
            label="Модели ролей"
            onClick={() => navigate("/settings/roles-models")}
          />
        </FieldGroup>
      </div>

      {/* Сервер */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">Сервер</div>
      <div className="mb-4">
        <ServerSection />
      </div>

      {/* Session */}
      <div className="mb-4">
        <FieldGroup>
          <Row icon="x" label="Выйти" danger onClick={logout} />
        </FieldGroup>
      </div>
    </div>
  );
}
