import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  FieldGroup,
  Icon,
  TextField,
  ScreenHeader,
} from "../components/UI";
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
    <div className="pb-bottom-safe px-5 flex flex-col min-h-[100dvh]">
      <ScreenHeader
        variant="compact"
        leading={
          <button
            onClick={() => navigate("/login")}
            className="w-11 h-11 -ml-2.5 flex items-center justify-center"
            aria-label="Назад"
          >
            <Icon name="chevronLeft" size={22} />
          </button>
        }
        title="Регистрация"
      />

      <div className="flex-1 flex flex-col items-center justify-start py-6">
        <h2 className="text-[20px] font-semibold mb-1">Создайте аккаунт</h2>
        <p className="text-[14px] text-sub mb-6">Присоединяйтесь к команде</p>

        <form onSubmit={handleSubmit} className="w-full">
          {/* Fields */}
          <div className="mb-4">
            <FieldGroup>
              <TextField
                icon="person"
                required
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Имя"
              />
              <TextField
                icon="mail"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
              />
              <TextField
                icon="lock"
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Пароль"
              />
              <TextField
                icon="lock"
                type="password"
                required
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Подтвердите пароль"
              />
            </FieldGroup>
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
                  className={`flex-1 h-12 flex items-center justify-center gap-2 rounded-xl border transition-colors ${
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
          <div className="mb-4">
            <Button type="submit" disabled={register.isPending}>
              {register.isPending ? "Создаём…" : "Создать аккаунт"}
            </Button>
          </div>
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
