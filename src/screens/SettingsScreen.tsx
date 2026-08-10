import { useNavigate } from "react-router-dom";
import { Icon } from "../components/UI";
import { useCurrentUser, useLogout } from "../api/auth";

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

export function SettingsScreen() {
  const navigate = useNavigate();
  const { data: user } = useCurrentUser();
  const logout = useLogout();

  return (
    <div className="px-4 pb-4">
      <div className="flex items-center justify-center h-[48px] mb-2 relative">
        <h2 className="text-[17px] font-semibold">Настройки</h2>
        <button
          onClick={() => navigate("/overview")}
          className="absolute right-0 w-[36px] h-[36px] rounded-full bg-red flex items-center justify-center"
        >
          <Icon name="check" size={18} className="text-white" />
        </button>
      </div>

      {/* Account section */}
      <div className="rounded-2xl overflow-hidden mb-4">
        <Row
          icon="person"
          label={user ? user.name : "Аккаунт"}
          value={user?.email}
        />
        <div className="h-px bg-stroke mx-4" />
        <Row icon="gear" label="Основное" />
        <div className="h-px bg-stroke mx-4" />
        <Row icon="zap" label="Подписка" />
        <div className="h-px bg-stroke mx-4" />
        <Row icon="calendarSmall" label="Календарь" />
      </div>

      {/* User settings */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">
        Пользовательские настройки
      </div>
      <div className="rounded-2xl overflow-hidden mb-4">
        <Row icon="moon" label="Тема" value="Темный" />
        <div className="h-px bg-stroke mx-4" />
        <Row icon="image" label="Иконка" value="Todoist" />
        <div className="h-px bg-stroke mx-4" />
        <Row icon="grid" label="Навигация" />
        <div className="h-px bg-stroke mx-4" />
        <Row icon="plus" label="Быстрое добавление" />
      </div>

      {/* Productivity */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">
        Продуктивность
      </div>
      <div className="rounded-2xl overflow-hidden mb-4">
        <Row icon="zap" label="Продуктивность" />
        <div className="h-px bg-stroke mx-4" />
        <Row icon="bell" label="Напоминания" />
        <div className="h-px bg-stroke mx-4" />
        <Row
          icon="bell"
          label="Уведомления"
          onClick={() => navigate("/notifications")}
        />
      </div>

      {/* Agents */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">
        Команда
      </div>
      <div className="rounded-2xl overflow-hidden mb-4">
        <Row icon="bot" label="Агенты" onClick={() => navigate("/agents")} />
        <div className="h-px bg-stroke mx-4" />
        <Row icon="link" label="Интеграции" />
      </div>

      {/* Session */}
      <div className="rounded-2xl overflow-hidden mb-4">
        <Row icon="x" label="Выйти" danger onClick={logout} />
      </div>
    </div>
  );
}
