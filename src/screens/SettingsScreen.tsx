import { useNavigate } from "react-router-dom";
import {
  FieldGroup,
  Icon,
  ScreenHeader,
  ErrorBanner,
  BackButton,
} from "../components/UI";
import { useCurrentUser, useLogout } from "../api/auth";
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
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 py-3 px-4 bg-card text-left"
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
      className={`tap-scale relative w-[43px] h-[25px] rounded-full shrink-0 transition-colors ${
        checked ? "bg-red" : "bg-card2 border border-stroke"
      }`}
    >
      <span
        className="absolute top-[2.5px] w-[20px] h-[20px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,.3)] transition-[right] duration-150"
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

export function SettingsScreen() {
  const navigate = useNavigate();
  const { data: user, error } = useCurrentUser();
  const logout = useLogout();
  const theme = useAppStore((s) => s.settings.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  return (
    <div className="px-4 pb-4">
      <ScreenHeader
        variant="compact"
        // Была своя красная кнопка-галочка справа («Готово») — Максим
        // (17.08.2026): «тут не галочка нужна, тут справа обычная кнопка
        // назад, как она везде у нас есть, стрелочка». Обычный BackButton
        // слева — тот же паттерн, что у Agents/TaskDetail/LabelTasks и
        // остальных compact-экранов (см. пример в комментарии самого
        // ScreenHeader в UI.tsx).
        leading={<BackButton onClick={() => navigate(-1)} />}
        title="Настройки"
        // Отступ снизу теперь встроен в сам ScreenHeader (UI.tsx) — Максим
        // 17.08.2026 попросил унифицировать его по всем экранам разом.
      />

      <ErrorBanner
        error={error}
        fallback="Не удалось загрузить профиль"
        variant="block"
      />

      {/* Account section */}
      <div className="mb-4">
        <FieldGroup>
          <Row
            icon="person"
            label={user ? user.name : "Аккаунт"}
            value={user?.email}
          />
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
            icon="bell"
            label="Уведомления"
            onClick={() => navigate("/notifications")}
          />
          <Row
            icon="activity"
            label="Активность"
            onClick={() => navigate("/activity")}
          />
          <Row icon="tag" label="Метки" onClick={() => navigate("/labels")} />
          <Row icon="bot" label="Агенты" onClick={() => navigate("/agents")} />
        </FieldGroup>
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
