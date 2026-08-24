import { registerPlugin } from "@capacitor/core";

export interface AppIconOption {
  id: string;
  name: string;
  subtitle: string;
  image: string;
  iconName: string | null;
}

export const APP_ICONS: AppIconOption[] = [
  {
    id: "liquid_glass",
    name: "Liquid Glass Ribbon",
    subtitle: "Лазерная галочка в потоке жидкого стекла (Full Bleed)",
    image: "/icons/icon_ribbon_flow.png",
    iconName: "AppIcon-LiquidGlass",
  },
  {
    id: "water_splash",
    name: "Dynamic Water Splash",
    subtitle: "Призматические брызги и неоновая галочка",
    image: "/icons/icon_liquid_glass.png",
    iconName: "AppIcon-WaterSplash",
  },
  {
    id: "cyber_crystal",
    name: "Cyber Crystal Energy",
    subtitle: "Лавовый кристалл и кольца света",
    image: "/icons/icon_cyber_crystal.png",
    iconName: "AppIcon-CyberCrystal",
  },
  {
    id: "minimal_neon",
    name: "Pure Minimal Glass",
    subtitle: "Неоновый градиент в матовом стекле",
    image: "/icons/icon_minimal_neon.png",
    iconName: "AppIcon-MinimalNeon",
  },
];

export interface AppIconPlugin {
  supportsAlternateIcons(): Promise<{ supported: boolean }>;
  getAlternateIcon(): Promise<{ iconName: string | null }>;
  setAlternateIcon(options: { name: string | null }): Promise<{ success: boolean; iconName: string | null }>;
}

const TFAppIcon = registerPlugin<AppIconPlugin>("TFAppIcon");

export const AppIconsService = {
  async isSupported(): Promise<boolean> {
    if (typeof window === "undefined") return false;
    try {
      if ((window as any).Capacitor?.isNativePlatform?.()) {
        const res = await TFAppIcon.supportsAlternateIcons();
        return !!res.supported;
      }
    } catch {
      // ignore
    }
    return false;
  },

  async getCurrentIcon(): Promise<string> {
    if (typeof window === "undefined") return "liquid_glass";
    try {
      if ((window as any).Capacitor?.isNativePlatform?.()) {
        const res = await TFAppIcon.getAlternateIcon();
        if (res.iconName) {
          const match = APP_ICONS.find((i) => i.iconName === res.iconName);
          if (match) return match.id;
        }
      }
    } catch {
      // ignore
    }
    return localStorage.getItem("taskflow_selected_icon") || "liquid_glass";
  },

  async setIcon(iconId: string): Promise<boolean> {
    const target = APP_ICONS.find((i) => i.id === iconId) || APP_ICONS[0];
    localStorage.setItem("taskflow_selected_icon", target.id);

    // Меняем фавиконку в веб-версии
    try {
      let link = document.querySelector("link[rel~='icon']") as HTMLLinkElement;
      if (!link) {
        link = document.createElement("link");
        link.rel = "icon";
        document.head.appendChild(link);
      }
      link.href = target.image;
    } catch {}

    if (typeof window !== "undefined" && (window as any).Capacitor?.isNativePlatform?.()) {
      try {
        await TFAppIcon.setAlternateIcon({ name: target.iconName });
        return true;
      } catch (e) {
        console.warn("Failed to set alternate icon:", e);
      }
    }
    return true;
  },
};
