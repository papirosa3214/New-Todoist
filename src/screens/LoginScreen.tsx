import { useNavigate } from "react-router-dom";
import { Icon } from "../components/UI";

export function LoginScreen() {
  const navigate = useNavigate();

  return (
    <div className="px-4 pb-4 flex flex-col min-h-full">
      <div className="flex-1 flex flex-col items-center justify-center">
        {/* Logo */}
        <div className="w-[72px] h-[72px] bg-red rounded-full flex items-center justify-center mb-3">
          <Icon name="check" size={36} className="text-white" />
        </div>
        <div className="text-[28px] font-bold mb-6">Todoist</div>

        {/* Welcome */}
        <h2 className="text-[20px] font-semibold mb-1">Добро пожаловать!</h2>
        <p className="text-[14px] text-sub mb-6">Войдите в свой аккаунт</p>

        {/* Form */}
        <div className="w-full bg-card rounded-2xl overflow-hidden mb-4">
          <div className="flex items-center gap-3 px-4 py-3.5 border-b border-stroke">
            <Icon name="mail" size={18} className="text-dim" />
            <span className="text-[15px] text-dim">Email</span>
          </div>
          <div className="flex items-center gap-3 px-4 py-3.5">
            <Icon name="lock" size={18} className="text-dim" />
            <span className="text-[15px] text-dim flex-1">Пароль</span>
            <Icon name="eye" size={18} className="text-dim" />
          </div>
        </div>

        {/* Login button */}
        <button
          onClick={() => navigate("/inbox")}
          className="w-full h-[50px] bg-red rounded-xl text-[16px] font-semibold text-white mb-4"
        >
          Войти
        </button>

        {/* Divider */}
        <div className="flex items-center gap-3 w-full mb-4">
          <div className="flex-1 h-px bg-stroke" />
          <span className="text-[13px] text-dim">или</span>
          <div className="flex-1 h-px bg-stroke" />
        </div>

        {/* Google */}
        <button className="w-full h-[50px] bg-card2 border border-stroke rounded-xl flex items-center justify-center gap-3 mb-6">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path d="M22.5 12.2c0-.8-.1-1.6-.2-2.3H12v4.4h5.9a5.1 5.1 0 0 1-2.2 3.3v2.8h3.6c2.1-1.9 3.2-4.8 3.2-8.2z" fill="#4285F4" />
            <path d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.3 1.1-3.7 1.1-2.8 0-5.2-1.9-6.1-4.5H2.2v2.9A11 11 0 0 0 12 23z" fill="#34A853" />
            <path d="M5.9 14.1a6.5 6.5 0 0 1 0-4.2V7H2.2a11 11 0 0 0 0 10l3.7-2.9z" fill="#FBBC05" />
            <path d="M12 5.3c1.5 0 2.9.5 3.9 1.5l2.9-2.9C17.5 2.3 15 1.3 12 1.3A11 11 0 0 0 2.2 7l3.7 2.9C6.8 7.1 9.2 5.3 12 5.3z" fill="#EA4335" />
          </svg>
          <span className="text-[15px] text-text">Войти через Google</span>
        </button>

        {/* Register link */}
        <p className="text-[14px] text-sub">
          Нет аккаунта?{" "}
          <button onClick={() => navigate("/register")} className="text-red font-medium">
            Зарегистрируйтесь
          </button>
        </p>
      </div>
    </div>
  );
}
