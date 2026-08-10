import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../components/UI";

export function RegisterScreen() {
  const navigate = useNavigate();
  const [role, setRole] = useState<"owner" | "agent">("owner");

  return (
    <div className="px-4 pb-4 flex flex-col min-h-full">
      {/* Header */}
      <div className="flex items-center h-[48px] mb-2 relative">
        <button onClick={() => navigate("/login")} className="w-[36px] h-[36px]">
          <Icon name="chevronLeft" size={22} />
        </button>
        <h2 className="absolute left-1/2 -translate-x-1/2 text-[17px] font-semibold">
          Регистрация
        </h2>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center">
        <h2 className="text-[20px] font-semibold mb-1">Создайте аккаунт</h2>
        <p className="text-[14px] text-sub mb-6">Присоединяйтесь к команде</p>

        {/* Fields */}
        <div className="w-full bg-card rounded-2xl overflow-hidden mb-4">
          {[
            { icon: "person", label: "Имя" },
            { icon: "mail", label: "Email" },
            { icon: "lock", label: "Пароль" },
            { icon: "lock", label: "Подтвердите пароль" },
          ].map((f, i, arr) => (
            <div key={f.label}>
              <div className="flex items-center gap-3 px-4 py-3.5">
                <Icon name={f.icon} size={18} className="text-dim" />
                <span className="text-[15px] text-dim">{f.label}</span>
              </div>
              {i < arr.length - 1 && <div className="h-px bg-stroke mx-4" />}
            </div>
          ))}
        </div>

        {/* Role selection */}
        <div className="w-full mb-4">
          <div className="text-[13px] text-sub font-semibold px-1 mb-2">Роль в команде</div>
          <div className="flex gap-3">
            {[
              { key: "owner" as const, icon: "crown", label: "Владелец" },
              { key: "agent" as const, icon: "bot", label: "Агент" },
            ].map((r) => (
              <button
                key={r.key}
                onClick={() => setRole(r.key)}
                className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border transition-colors ${
                  role === r.key
                    ? "border-red text-red bg-red/10"
                    : "border-stroke text-sub bg-card"
                }`}
              >
                <Icon name={r.icon} size={18} />
                <span className="text-[14px] font-medium">{r.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Submit */}
        <button
          onClick={() => navigate("/login")}
          className="w-full h-[50px] bg-red rounded-xl text-[16px] font-semibold text-white mb-4"
        >
          Создать аккаунт
        </button>

        <p className="text-[14px] text-sub">
          Уже есть аккаунт?{" "}
          <button onClick={() => navigate("/login")} className="text-red font-medium">
            Войти
          </button>
        </p>
      </div>
    </div>
  );
}
