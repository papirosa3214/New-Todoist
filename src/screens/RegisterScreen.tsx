import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  ErrorBanner,
  FieldGroup,
  TextField,
  ScreenHeader,
  BackButton,
} from "../components/UI";
import { useRegister } from "../api/auth";
import { useGuardedCallback } from "../lib/useGuardedCallback";

export function RegisterScreen() {
  const navigate = useNavigate();
  const register = useRegister();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = useGuardedCallback(async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (password !== confirmPassword) {
      setLocalError("Пароли не совпадают");
      return;
    }
    await register.mutateAsync({
      name: name.trim(),
      email: email.trim(),
      password,
    });
    navigate("/overview", { replace: true });
  });

  return (
    <div className="pb-bottom-safe px-5 flex flex-col min-h-[100dvh]">
      <ScreenHeader
        variant="compact"
        leading={<BackButton onClick={() => navigate("/login")} />}
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

          <ErrorBanner
            error={localError || register.error}
            fallback="Не удалось зарегистрироваться"
            variant="block"
            className="mb-4"
          />

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
