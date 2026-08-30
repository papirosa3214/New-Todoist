import { useState } from "react";
import { useUpdateProfile } from "../api/auth";
import type { ApiUser } from "../api/types";
import { getErrorMessage } from "../lib/errors";
import { hapticTap, hapticSuccess, hapticError } from "../lib/haptics";
import { X, Check, User, Mail, Lock, KeyRound } from "lucide-react";

interface Props {
  user: ApiUser;
  isOpen: boolean;
  onClose: () => void;
}

export function EditProfileModal({ user, isOpen, onClose }: Props) {
  const [name, setName] = useState(user.name || "");
  const [email, setEmail] = useState(user.email || "");
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const updateProfile = useUpdateProfile();

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (!name.trim()) {
      setError("Имя не может быть пустым");
      return;
    }
    if (!email.trim()) {
      setError("Email/логин не может быть пустым");
      return;
    }
    if (password && password.length < 4) {
      setError("Пароль должен содержать минимум 4 символа");
      return;
    }

    hapticTap();
    updateProfile.mutate(
      {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password: password ? password : undefined,
        currentPassword: currentPassword ? currentPassword : undefined,
      },
      {
        onSuccess: () => {
          hapticSuccess();
          setSuccess(true);
          setPassword("");
          setCurrentPassword("");
          setTimeout(() => {
            onClose();
            setSuccess(false);
          }, 1200);
        },
        onError: (err) => {
          hapticError();
          setError(getErrorMessage(err));
        },
      },
    );
  };

  return (
    <div
      // Свайп «назад» не должен уводить экран из-под шторки
      // (useSwipeBack ищет этот атрибут).
      data-overlay
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-fade-in safe-area-all"
    >
      <div className="w-full max-w-md bg-card border border-stroke rounded-3xl p-6 shadow-2xl animate-scale-up text-text flex flex-col max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-stroke mb-5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-card2 flex items-center justify-center">
              <User className="w-4 h-4 text-red" />
            </div>
            <h3 className="text-lg font-bold text-text tracking-tight">
              Редактировать профиль
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-card2 hover:bg-card2/80 flex items-center justify-center text-dim hover:text-text transition-[background-color,color] duration-150"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {error && (
            <div className="text-[13px] text-coral bg-coral/10 border border-coral/20 px-3.5 py-2 rounded-xl">
              {error}
            </div>
          )}

          {success && (
            <div className="text-[13px] text-green bg-green/10 border border-green/20 px-3.5 py-2 rounded-xl flex items-center gap-2">
              <Check className="w-4 h-4" />
              Данные успешно сохранены!
            </div>
          )}

          {/* Name Field */}
          <div>
            <label className="text-xs font-semibold text-sub uppercase tracking-wider mb-1.5 block px-1">
              Имя пользователя
            </label>
            <div className="relative flex items-center">
              <User className="w-4 h-4 absolute left-3.5 text-dim pointer-events-none" />
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ваше имя"
                className="w-full bg-card border border-stroke rounded-2xl py-3 pl-10 pr-4 text-[15px] text-text placeholder-sub focus:outline-none focus:border-red focus-visible:ring-2 focus-visible:ring-red/30 transition-[border-color,box-shadow] duration-150"
                required
              />
            </div>
          </div>

          {/* Email / Login Field */}
          <div>
            <label className="text-xs font-semibold text-sub uppercase tracking-wider mb-1.5 block px-1">
              Email / Логин для входа
            </label>
            <div className="relative flex items-center">
              <Mail className="w-4 h-4 absolute left-3.5 text-dim pointer-events-none" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="example@mail.com"
                className="w-full bg-card border border-stroke rounded-2xl py-3 pl-10 pr-4 text-[15px] text-text placeholder-sub focus:outline-none focus:border-red focus-visible:ring-2 focus-visible:ring-red/30 transition-[border-color,box-shadow] duration-150"
                required
              />
            </div>
          </div>

          {/* Password Change Divider */}
          <div className="pt-2 border-t border-stroke">
            <span className="text-[13px] font-semibold text-sub block mb-3">
              Смена пароля{" "}
              <span className="text-xs text-dim font-normal">
                (оставьте пустым, если не меняете)
              </span>
            </span>

            <div className="flex flex-col gap-3">
              <div>
                <label className="text-xs text-sub mb-1 block px-1">
                  Текущий пароль
                </label>
                <div className="relative flex items-center">
                  <KeyRound className="w-4 h-4 absolute left-3.5 text-dim pointer-events-none" />
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Введите текущий пароль"
                    className="w-full bg-card border border-stroke rounded-2xl py-2.5 pl-10 pr-4 text-[14px] text-text placeholder-sub focus:outline-none focus:border-red focus-visible:ring-2 focus-visible:ring-red/30 transition-[border-color,box-shadow] duration-150"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs text-sub mb-1 block px-1">
                  Новый пароль
                </label>
                <div className="relative flex items-center">
                  <Lock className="w-4 h-4 absolute left-3.5 text-dim pointer-events-none" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Минимум 4 символов"
                    className="w-full bg-card border border-stroke rounded-2xl py-2.5 pl-10 pr-4 text-[14px] text-text placeholder-sub focus:outline-none focus:border-red focus-visible:ring-2 focus-visible:ring-red/30 transition-[border-color,box-shadow] duration-150"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Info notice */}
          <div className="text-[12px] text-dim bg-card2/60 border border-stroke p-3 rounded-xl leading-relaxed mt-1">
            💡 Все ваши задачи, проекты, метки, интеграции и история диалогов с
            AI моделями сохраняются в полном объёме при изменении логина и
            пароля.
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-3 rounded-2xl bg-card2 hover:bg-card2/80 text-text font-medium text-[14px] transition-[background-color] duration-150"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={updateProfile.isPending}
              className="flex-1 py-3 rounded-2xl bg-red-solid hover:bg-red text-text font-semibold text-[14px] shadow-lg shadow-red/30 active:scale-[0.98] transition-transform duration-150 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-red/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              {updateProfile.isPending ? "Сохранение..." : "Сохранить"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
