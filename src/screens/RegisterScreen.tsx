import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../components/UI";
import { useRegister } from "../api/auth";
import { ApiError } from "../api/client";

export function RegisterScreen() {
  const navigate = useNavigate();
  const register = useRegister();
  const [role, setRole] = useState<"owner" | "agent">("owner");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError("Пароли не совпадают");
      return;
    }
    try {
      await register.mutateAsync({
        name: name.trim(),
        email: email.trim(),
        password,
        role,
      });
      navigate("/inbox", { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Не удалось зарегистрироваться",
      );
    }
  };

  return (
    <div className="px-4 pb-4 flex flex-col min-h-full">
      {/* Header */}
      <div className="flex items-center h-[48px] mb-2 relative">
        <button
          onClick={() => navigate("/login")}
          className="w-[36px] h-[36px]"
        >
          <Icon name="chevronLeft" size={22} />
        </button>
        <h2 className="absolute left-1/2 -translate-x-1/2 text-[17px] font-semibold">
          Регистрация
        </h2>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center">
        <h2 className="text-[20px] font-semibold mb-1">Создайте аккаунт</h2>
        <p className="text-[14px] text-sub mb-6">Присоединяйтесь к команде</p>

        <form onSubmit={handleSubmit} className="w-full">
          {/* Fields */}
          <div className="w-full bg-card rounded-2xl overflow-hidden mb-4">
            <div className="flex items-center gap-3 px-4 py-3.5">
              <Icon name="person" size={18} className="text-dim" />
              <input
                required
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Имя"
                className="flex-1 bg-transparent text-[15px] text-text placeholder:text-dim outline-none"
              />
            </div>
            <div className="h-px bg-stroke mx-4" />
            <div className="flex items-center gap-3 px-4 py-3.5">
              <Icon name="mail" size={18} className="text-dim" />
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
                className="flex-1 bg-transparent text-[15px] text-text placeholder:text-dim outline-none"
              />
            </div>
            <div className="h-px bg-stroke mx-4" />
            <div className="flex items-center gap-3 px-4 py-3.5">
              <Icon name="lock" size={18} className="text-dim" />
              <input
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Пароль"
                className="flex-1 bg-transparent text-[15px] text-text placeholder:text-dim outline-none"
              />
            </div>
            <div className="h-px bg-stroke mx-4" />
            <div className="flex items-center gap-3 px-4 py-3.5">
              <Icon name="lock" size={18} className="text-dim" />
              <input
                type="password"
                required
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Подтвердите пароль"
                className="flex-1 bg-transparent text-[15px] text-text placeholder:text-dim outline-none"
              />
            </div>
          </div>

          {/* Role selection */}
          <div className="w-full mb-4">
            <div className="text-[13px] text-sub font-semibold px-1 mb-2">
              Роль в команде
            </div>
            <div className="flex gap-3">
              {[
                { key: "owner" as const, icon: "crown", label: "Владелец" },
                { key: "agent" as const, icon: "bot", label: "Агент" },
              ].map((r) => (
                <button
                  key={r.key}
                  type="button"
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

          {error && (
            <p className="text-[13px] text-coral mb-3 text-center">{error}</p>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={register.isPending}
            className="w-full h-[50px] bg-red rounded-xl text-[16px] font-semibold text-white mb-4 disabled:opacity-60"
          >
            {register.isPending ? "Создаём…" : "Создать аккаунт"}
          </button>
        </form>

        <p className="text-[14px] text-sub">
          Уже есть аккаунт?{" "}
          <button
            onClick={() => navigate("/login")}
            className="text-red font-medium"
          >
            Войти
          </button>
        </p>
      </div>
    </div>
  );
}
