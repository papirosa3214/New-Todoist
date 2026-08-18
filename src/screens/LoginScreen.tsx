import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  ErrorBanner,
  FieldGroup,
  Icon,
  TextField,
} from "../components/UI";
import { useLogin } from "../api/auth";
import { useGuardedCallback } from "../lib/useGuardedCallback";

export function LoginScreen() {
  const navigate = useNavigate();
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = useGuardedCallback(async (e: FormEvent) => {
    e.preventDefault();
    await login.mutateAsync({ email: email.trim(), password });
    navigate("/inbox", { replace: true });
  });

  return (
    <div className="pb-bottom-safe px-5 flex flex-col min-h-[100dvh]">
      <div className="flex-1 flex flex-col items-center justify-center py-8">
        {/* Logo */}
        <div className="w-[72px] h-[72px] bg-red rounded-full flex items-center justify-center mb-3">
          <Icon name="check" size={36} className="text-white" />
        </div>
        <div className="text-[28px] font-bold mb-6">Todoist</div>

        {/* Welcome */}
        <h2 className="text-[20px] font-semibold mb-1">Добро пожаловать!</h2>
        <p className="text-[14px] text-sub mb-6">Войдите в свой аккаунт</p>

        {/* Form */}
        <form onSubmit={handleSubmit} className="w-full">
          <div className="mb-4">
            <FieldGroup>
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
                type={showPassword ? "text" : "password"}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Пароль"
                trailing={
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={
                      showPassword ? "Скрыть пароль" : "Показать пароль"
                    }
                    className="shrink-0 h-full aspect-square flex items-center justify-center"
                  >
                    <Icon name="eye" size={18} className="text-dim" />
                  </button>
                }
              />
            </FieldGroup>
          </div>

          <ErrorBanner
            error={login.error}
            fallback="Не удалось войти"
            variant="block"
            className="mb-4"
          />

          {/* Login button */}
          <div className="mb-4">
            <Button type="submit" disabled={login.isPending}>
              {login.isPending ? "Входим…" : "Войти"}
            </Button>
          </div>
        </form>

        {/* Register link */}
        <p className="text-[14px] text-sub">
          Нет аккаунта?{" "}
          <button
            onClick={() => navigate("/register")}
            className="text-red font-medium"
          >
            Зарегистрируйтесь
          </button>
        </p>
      </div>
    </div>
  );
}
