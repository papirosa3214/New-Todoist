import { registerPlugin } from "@capacitor/core";

export interface BiometricAvailability {
  available: boolean;
  biometryType: "faceId" | "touchId" | "opticId" | "none";
  error?: string;
}

export interface BiometricPlugin {
  isAvailable(): Promise<BiometricAvailability>;
  authenticate(options?: { reason?: string }): Promise<{ success: boolean; error?: string }>;
}

const TFBiometric = registerPlugin<BiometricPlugin>("TFBiometric");

const FACE_ID_PREF_KEY = "taskflow_faceid_enabled";

export const Biometrics = {
  /** Проверка доступности Face ID / Touch ID на устройстве */
  async isAvailable(): Promise<BiometricAvailability> {
    if (typeof window === "undefined") return { available: false, biometryType: "none" };
    try {
      if ((window as any).Capacitor?.isNativePlatform?.()) {
        return await TFBiometric.isAvailable();
      }
    } catch {
      // ignore
    }
    return { available: false, biometryType: "none" };
  },

  /** Запрос сканирования Face ID / Touch ID */
  async authenticate(reason = "Вход в TaskFlow"): Promise<boolean> {
    if (typeof window === "undefined") return false;
    try {
      if ((window as any).Capacitor?.isNativePlatform?.()) {
        const res = await TFBiometric.authenticate({ reason });
        return !!res.success;
      }
    } catch (e) {
      console.warn("Biometric auth error:", e);
    }
    return false;
  },

  /** Включен ли вход по Face ID в настройках */
  isEnabled(): boolean {
    if (typeof window === "undefined") return false;
    const val = localStorage.getItem(FACE_ID_PREF_KEY);
    return val !== "false";
  },

  /** Сохранить состояние переключателя Face ID */
  setEnabled(enabled: boolean) {
    if (typeof window === "undefined") return;
    localStorage.setItem(FACE_ID_PREF_KEY, enabled ? "true" : "false");
  },
};
