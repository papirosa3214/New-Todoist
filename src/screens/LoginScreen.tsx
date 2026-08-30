import { useState, useEffect, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  ErrorBanner,
  FieldGroup,
  Icon,
  TextField,
} from "../components/UI";
import { useLogin } from "../api/auth";
import { getToken, tryLanLogin } from "../api/client";
import { Biometrics, type BiometricAvailability } from "../lib/biometrics";
import { useGuardedCallback } from "../lib/useGuardedCallback";

export function LoginScreen() {
  const navigate = useNavigate();
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [bioInfo, setBioInfo] = useState<BiometricAvailability>({
    available: false,
    biometryType: "none",
  });
  const [isBioAuthenticating, setIsBioAuthenticating] = useState(false);
  const [bioError, setBioError] = useState<string | null>(null);

  // Проверяем доступность Face ID / Touch ID
  useEffect(() => {
    Biometrics.isAvailable().then((info) => {
      setBioInfo(info);
      if (info.available && Biometrics.isEnabled()) {
        // Автоматически запускаем сканирование Face ID при открытии
        handleBiometricLogin();
      }
    });
  }, []);

  const handleBiometricLogin = async () => {
    setBioError(null);
    setIsBioAuthenticating(true);
    try {
      const ok = await Biometrics.authenticate("Вход в TaskFlow");
      if (ok) {
        // Проверяем наличие токена или получаем по локальной сети
        let token = getToken();
        if (!token) {
          token = await tryLanLogin();
        }
        if (token) {
          navigate("/overview", { replace: true });
          return;
        } else {
          setBioError(
            "Введите логин и пароль один раз для привязки устройства",
          );
        }
      }
    } catch {
      // Пользователь отменил или ошибка
    } finally {
      setIsBioAuthenticating(false);
    }
  };

  const handleSubmit = useGuardedCallback(async (e: FormEvent) => {
    e.preventDefault();
    setBioError(null);
    await login.mutateAsync({ email: email.trim(), password });
    // Включаем биометрию на устройстве после успешного входа
    Biometrics.setEnabled(true);
    navigate("/overview", { replace: true });
  });

  const isFaceId = bioInfo.biometryType === "faceId";
  const bioTitle = isFaceId
    ? "Войти с Face ID"
    : bioInfo.biometryType === "touchId"
      ? "Войти с Touch ID"
      : "Войти по биометрии";

  return (
    <div className="pb-bottom-safe px-5 flex flex-col min-h-[100dvh]">
      <div className="flex-1 flex flex-col items-center justify-center py-8">
        {/* Logo */}
        <div className="w-[72px] h-[72px] bg-red rounded-full flex items-center justify-center mb-3 shadow-md">
          <Icon name="check" size={36} className="text-white" />
        </div>
        <div className="text-[28px] font-bold mb-6">TaskFlow</div>

        {/* Welcome */}
        <h2 className="text-[20px] font-semibold mb-1">Добро пожаловать!</h2>
        <p className="text-[14px] text-sub mb-6">Войдите в свой аккаунт</p>

        {/* Быстрый вход по Face ID (если доступен) */}
        {bioInfo.available && (
          <div className="w-full mb-6">
            <button
              type="button"
              onClick={handleBiometricLogin}
              disabled={isBioAuthenticating}
              className="w-full py-3.5 px-4 bg-card border border-stroke/60 hover:border-coral/50 rounded-2xl flex items-center justify-center gap-3 text-text font-semibold text-[15px] shadow-xs active:scale-[0.98] transition-all"
            >
              <div className="w-7 h-7 rounded-xl bg-coral/10 text-coral flex items-center justify-center">
                {isFaceId ? (
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M7 3H5a2 2 0 0 0-2 2v2" />
                    <path d="M17 3h2a2 2 0 0 1 2 2v2" />
                    <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
                    <path d="M3 17v2a2 2 0 0 0 2 2h2" />
                    <path d="M9 9h.01" />
                    <path d="M15 9h.01" />
                    <path d="M10 13a2 2 0 0 0 4 0" />
                  </svg>
                ) : (
                  <Icon name="shield" size={18} />
                )}
              </div>
              <span>{isBioAuthenticating ? "Сканирование..." : bioTitle}</span>
            </button>

            {bioError && (
              <div className="text-xs text-coral mt-2 text-center">
                {bioError}
              </div>
            )}

            <div className="relative flex py-4 items-center">
              <div className="flex-grow border-t border-stroke/40"></div>
              <span className="flex-shrink mx-4 text-xs text-dim">
                или по паролю
              </span>
              <div className="flex-grow border-t border-stroke/40"></div>
            </div>
          </div>
        )}

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
      </div>
    </div>
  );
}
