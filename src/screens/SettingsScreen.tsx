import { useNavigate } from "react-router-dom";
import { useRef, useState } from "react";
import {
  FieldGroup,
  Icon,
  ScreenHeader,
  ErrorBanner,
  Avatar,
} from "../components/UI";
import { useCurrentUser, useLogout } from "../api/auth";
import { useServerStatus } from "../api/server";
import { useAgentService, useToggleAgentService } from "../api/agents";
import { useUploadAvatar, useDeleteAvatar } from "../api/avatars";
import { getErrorMessage } from "../lib/errors";
import { useAppStore } from "../store";

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
  valueLabel: string;
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
      <span className="text-[13px] text-sub">{valueLabel}</span>
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
}: {
  userId: string;
  name: string;
  email?: string;
  initials?: string;
  color?: string;
  avatarUrl?: string | null;
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
      <div className="flex-1 min-w-0">
        <div className="text-[15px] text-text truncate">{name}</div>
        {email && <div className="text-[13px] text-sub truncate">{email}</div>}
        {error && <div className="text-[12px] text-coral mt-0.5">{error}</div>}
      </div>
      {avatarUrl && (
        <button
          type="button"
          onClick={() => del.mutate()}
          disabled={busy}
          aria-label="Убрать аватарку"
          // tap-fade — текстовая ссылка: менять форму нечему, отклик несёт
          // прозрачность.
          className="tap-fade text-[13px] text-sub shrink-0"
        >
          Убрать
        </button>
      )}
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
  const { data, error, isLoading } = useServerStatus();
  const { data: service } = useAgentService();
  const toggleService = useToggleAgentService();
  const serviceOn = service?.active ?? false;

  // Сервер не ответил — это и есть главная новость экрана, и сказать её
  // надо словами, а не пустым местом.
  if (error) {
    return (
      <FieldGroup>
        <InfoRow
          icon="x"
          iconColor="#FF6B6B"
          label="Сервер"
          value="не отвечает"
        />
      </FieldGroup>
    );
  }
  if (isLoading || !data) {
    return (
      <FieldGroup>
        <InfoRow icon="activity" label="Сервер" value="проверяю…" />
      </FieldGroup>
    );
  }

  return (
    <FieldGroup>
      <InfoRow
        icon="activity"
        iconColor="#4CAF50"
        label="Сервер"
        value={`работает ${fmtUptime(data.uptime_sec)}`}
      />
      {data.commit && (
        <InfoRow
          icon="tag"
          iconColor="#4a9fd8"
          label="Версия"
          value={
            data.commit_at
              ? `${data.commit} · ${new Date(data.commit_at).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}`
              : data.commit
          }
        />
      )}
      <ToggleRow
        icon="bell"
        iconColor="#FF6B6B"
        label="Будильник (служба)"
        valueLabel={serviceOn ? "Включён" : "Выключен"}
        checked={serviceOn}
        onChange={() => toggleService.mutate(!serviceOn)}
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
            />
          ) : (
            <Row icon="person" label="Аккаунт" />
          )}
        </FieldGroup>
      </div>

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
          <InfoRow icon="image" label="Иконка" value="Todoist" />
        </FieldGroup>
      </div>

      {/* General */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">Общие</div>
      <div className="mb-4">
        <FieldGroup>
          <Row
            icon="hash"
            iconColor="#E44235"
            label="Проекты"
            onClick={() => navigate("/projects")}
          />
          <Row
            icon="bookmark"
            iconColor="#FF9500"
            label="Шаблоны задач"
            onClick={() => navigate("/settings/templates")}
          />
          <Row icon="tag" label="Метки" onClick={() => navigate("/labels")} />
          <Row icon="bot" label="Команда" onClick={() => navigate("/agents")} />
          <Row
            icon="mic"
            iconColor="#4a9fd8"
            label="Модели распознавания"
            onClick={() => navigate("/settings/voice-models")}
          />
          <Row
            icon="share"
            iconColor="#34C759"
            label="Интеграции (Google, Apple)"
            onClick={() => navigate("/settings/integrations")}
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
