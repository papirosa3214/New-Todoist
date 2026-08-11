import { useNavigate } from "react-router-dom";
import { FieldGroup, Icon, ScreenHeader, ErrorBanner } from "../components/UI";
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

export function SettingsScreen() {
  const navigate = useNavigate();
  const { data: user, error } = useCurrentUser();
  const logout = useLogout();

  return (
    <div className="px-4 pb-4">
      <ScreenHeader
        variant="compact"
        title="Настройки"
        actions={
          <button
            onClick={() => navigate("/overview")}
            className="w-[44px] h-[44px] flex items-center justify-center"
            aria-label="Готово"
          >
            <span className="w-[36px] h-[36px] rounded-full bg-red flex items-center justify-center">
              <Icon name="check" size={18} className="text-white" />
            </span>
          </button>
        }
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
          <InfoRow icon="moon" label="Тема" value="Темный" />
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
