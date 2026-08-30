import { useEffect, useState, useRef, type ReactNode } from "react";
import { App as CapApp } from "@capacitor/app";
import { Biometrics } from "../lib/biometrics";
import { getToken } from "../api/client";
import { hapticTap } from "../lib/haptics";

interface Props {
  children: ReactNode;
}

// Порог в фоне — 60 секунд (чтобы шторка уведомлений и быстрый переход в другое приложение не дёргали проверку)
const LOCK_TIMEOUT_MS = 60 * 1000;

export function BiometricLockGuard({ children }: Props) {
  const [isLocked, setIsLocked] = useState(false);
  const lastBackgroundTime = useRef<number | null>(null);
  const isRunningAuth = useRef(false);
  const hasCheckedInitial = useRef(false);

  const requestNativeAuth = async () => {
    if (isRunningAuth.current) return;
    isRunningAuth.current = true;

    try {
      const success = await Biometrics.authenticate("Вход в TaskFlow");
      if (success) {
        setIsLocked(false);
      } else {
        setIsLocked(true);
      }
    } catch {
      setIsLocked(true);
    } finally {
      setTimeout(() => {
        isRunningAuth.current = false;
      }, 600);
    }
  };

  useEffect(() => {
    if (hasCheckedInitial.current) return;
    hasCheckedInitial.current = true;

    // Холодный старт: если включён Face ID — вызываем нативную аутентификацию Apple
    Biometrics.isAvailable().then((info) => {
      const token = getToken();
      const enabled = Biometrics.isEnabled();

      if (token && info.available && enabled) {
        setIsLocked(true);
        setTimeout(() => {
          requestNativeAuth();
        }, 100);
      }
    });

    // Слушатель ухода в фон / возврата
    const sub = CapApp.addListener("appStateChange", ({ isActive }) => {
      if (isRunningAuth.current) return;

      const token = getToken();
      const enabled = Biometrics.isEnabled();

      if (!isActive) {
        lastBackgroundTime.current = Date.now();
      } else {
        const bgDuration = lastBackgroundTime.current
          ? Date.now() - lastBackgroundTime.current
          : 0;
        lastBackgroundTime.current = null;

        // Блокируем только если приложение РЕАЛЬНО было свёрнуто дольше минуты
        if (token && enabled && bgDuration >= LOCK_TIMEOUT_MS) {
          setIsLocked(true);
          setTimeout(() => {
            requestNativeAuth();
          }, 100);
        }
      }
    });

    return () => {
      sub.then((s) => s.remove());
    };
  }, []);

  if (!isLocked) {
    return <>{children}</>;
  }

  // Минималистичный экран ожидания без лишней графики
  return (
    <div
      // Свайп «назад» не должен уводить экран из-под шторки
      // (useSwipeBack ищет этот атрибут).
      data-overlay
      className="fixed inset-0 z-[99999] bg-bg flex flex-col items-center justify-center p-6 select-none safe-area-all"
    >
      <button
        type="button"
        onClick={() => {
          hapticTap();
          requestNativeAuth();
        }}
        className="py-3 px-8 rounded-xl bg-card2 border border-stroke text-text text-[15px] font-medium active:scale-95 transition-transform"
      >
        Повторить Face ID
      </button>
    </div>
  );
}
