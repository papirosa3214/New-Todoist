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
      <div className="w-full max-w-md bg-[#1C1C1E] border border-white/10 rounded-3xl p-6 shadow-2xl animate-scale-up text-white flex flex-col max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-white/10 mb-5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-white/10 flex items-center justify-center">
              <User className="w-4 h-4 text-[#FF2D55]" />
            </div>
            <h3 className="text-lg font-bold text-white tracking-tight">
              Редактировать профиль
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {error && (
            <div className="text-[13px] text-[#FF453A] bg-[#FF453A]/10 border border-[#FF453A]/20 px-3.5 py-2 rounded-xl">
              {error}
            </div>
          )}

          {success && (
            <div className="text-[13px] text-[#34C759] bg-[#34C759]/10 border border-[#34C759]/20 px-3.5 py-2 rounded-xl flex items-center gap-2">
              <Check className="w-4 h-4" />
              Данные успешно сохранены!
            </div>
          )}

          {/* Name Field */}
          <div>
            <label className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-1.5 block px-1">
              Имя пользователя
            </label>
            <div className="relative flex items-center">
              <User className="w-4 h-4 absolute left-3.5 text-white/40 pointer-events-none" />
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ваше имя"
                className="w-full bg-white/5 border border-white/10 rounded-2xl py-3 pl-10 pr-4 text-[15px] text-white placeholder-white/30 focus:outline-none focus:border-[#FF2D55] transition-colors"
                required
              />
            </div>
          </div>

          {/* Email / Login Field */}
          <div>
            <label className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-1.5 block px-1">
              Email / Логин для входа
            </label>
            <div className="relative flex items-center">
              <Mail className="w-4 h-4 absolute left-3.5 text-white/40 pointer-events-none" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="example@mail.com"
                className="w-full bg-white/5 border border-white/10 rounded-2xl py-3 pl-10 pr-4 text-[15px] text-white placeholder-white/30 focus:outline-none focus:border-[#FF2D55] transition-colors"
                required
              />
            </div>
          </div>

          {/* Password Change Divider */}
          <div className="pt-2 border-t border-white/10">
            <span className="text-[13px] font-semibold text-white/70 block mb-3">
              Смена пароля{" "}
              <span className="text-xs text-white/40 font-normal">
                (оставьте пустым, если не меняете)
              </span>
            </span>

            <div className="flex flex-col gap-3">
              <div>
                <label className="text-xs text-white/50 mb-1 block px-1">
                  Текущий пароль
                </label>
                <div className="relative flex items-center">
                  <KeyRound className="w-4 h-4 absolute left-3.5 text-white/40 pointer-events-none" />
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Введите текущий пароль"
                    className="w-full bg-white/5 border border-white/10 rounded-2xl py-2.5 pl-10 pr-4 text-[14px] text-white placeholder-white/30 focus:outline-none focus:border-[#FF2D55] transition-colors"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs text-white/50 mb-1 block px-1">
                  Новый пароль
                </label>
                <div className="relative flex items-center">
                  <Lock className="w-4 h-4 absolute left-3.5 text-white/40 pointer-events-none" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Минимум 4 символа"
                    className="w-full bg-white/5 border border-white/10 rounded-2xl py-2.5 pl-10 pr-4 text-[14px] text-white placeholder-white/30 focus:outline-none focus:border-[#FF2D55] transition-colors"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Info notice */}
          <div className="text-[12px] text-white/40 bg-white/[0.02] border border-white/5 p-3 rounded-xl leading-relaxed mt-1">
            💡 Все ваши задачи, проекты, метки, интеграции и история диалогов с
            AI моделями сохраняются в полном объёме при изменении логина и
            пароля.
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-3 rounded-2xl bg-white/10 hover:bg-white/15 text-white font-medium text-[14px] transition-colors"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={updateProfile.isPending}
              className="flex-1 py-3 rounded-2xl bg-[#FF2D55] hover:bg-[#FF375F] text-white font-semibold text-[14px] shadow-lg shadow-[#FF2D55]/30 active:scale-[0.98] transition-all disabled:opacity-50"
            >
              {updateProfile.isPending ? "Сохранение..." : "Сохранить"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
