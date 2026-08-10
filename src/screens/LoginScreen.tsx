import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button, FieldGroup, Icon, TextField } from "../components/UI";
import { useLogin } from "../api/auth";
import { ApiError } from "../api/client";

export function LoginScreen() {
  const navigate = useNavigate();
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await login.mutateAsync({ email: email.trim(), password });
      navigate("/inbox", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось войти");
    }
  };

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

          {error && (
            <p className="text-[13px] text-coral mb-3 text-center">{error}</p>
          )}

          {/* Login button */}
          <div className="mb-4">
            <Button type="submit" disabled={login.isPending}>
              {login.isPending ? "Входим…" : "Войти"}
            </Button>
          </div>
        </form>

        {/* Divider */}
        <div className="flex items-center gap-3 w-full mb-4">
          <div className="flex-1 h-px bg-stroke" />
          <span className="text-[13px] text-dim">или</span>
          <div className="flex-1 h-px bg-stroke" />
        </div>

        {/* Google — not backed by any server endpoint, kept as a visual reference only */}
        <div className="w-full mb-6">
          <Button
            variant="secondary"
            disabled
            className="opacity-50 cursor-not-allowed"
          >
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path
                d="M22.5 12.2c0-.8-.1-1.6-.2-2.3H12v4.4h5.9a5.1 5.1 0 0 1-2.2 3.3v2.8h3.6c2.1-1.9 3.2-4.8 3.2-8.2z"
                fill="#4285F4"
              />
              <path
                d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.3 1.1-3.7 1.1-2.8 0-5.2-1.9-6.1-4.5H2.2v2.9A11 11 0 0 0 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.9 14.1a6.5 6.5 0 0 1 0-4.2V7H2.2a11 11 0 0 0 0 10l3.7-2.9z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.3c1.5 0 2.9.5 3.9 1.5l2.9-2.9C17.5 2.3 15 1.3 12 1.3A11 11 0 0 0 2.2 7l3.7 2.9C6.8 7.1 9.2 5.3 12 5.3z"
                fill="#EA4335"
              />
            </svg>
            <span className="text-[15px] text-text">Войти через Google</span>
          </Button>
        </div>

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
