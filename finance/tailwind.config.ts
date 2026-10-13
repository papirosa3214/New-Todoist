import type { Config } from "tailwindcss";

/**
 * Токены темы — раздел 2 дизайн-системы (docs/design/2026-10-13-finance-design-system.md).
 * Здесь задаются цвета, радиусы и анимации. Больше нигде.
 */
const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 2.1 Нейтрали
        ink: {
          50: "#f4f3f0",
          100: "#f1f5f9",
          200: "#e2e8f0",
          300: "#cbd5e1",
          400: "#94a3b8",
          500: "#64748b",
          600: "#475569",
          700: "#334155",
          800: "#1e293b",
          900: "#0f172a",
        },
        // 2.2 Акцент (бирюза)
        accent: {
          50: "#eefaf7",
          100: "#d3f2eb",
          500: "#0d9488",
          600: "#0f766e",
          700: "#115e59",
        },
        // 2.3 Семантические
        danger: {
          50: "#fef2f2",
          200: "#fecaca",
          500: "#dc2626",
          600: "#b91c1c",
        },
        warning: {
          50: "#fffbeb",
          200: "#fde68a",
          600: "#b45309",
        },
        // Переменные shadcn (раздел 3)
        background: "var(--background)",
        foreground: "var(--foreground)",
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        card: "var(--card)",
        "card-foreground": "var(--card-foreground)",
        popover: "var(--popover)",
        "popover-foreground": "var(--popover-foreground)",
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
        },
      },
      borderRadius: {
        lg: "12px",
        md: "8px",
        sm: "6px",
        xl: "16px",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "overlay-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "dialog-in": {
          from: { opacity: "0", transform: "translate(-50%, -48%) scale(0.98)" },
          to: { opacity: "1", transform: "translate(-50%, -50%) scale(1)" },
        },
        "sheet-in-right": {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
        "sheet-in-bottom": {
          from: { transform: "translateY(100%)" },
          to: { transform: "translateY(0)" },
        },
        "toast-in": {
          from: { opacity: "0", transform: "translate(-50%, 12px)" },
          to: { opacity: "1", transform: "translate(-50%, 0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 120ms ease-out",
        "overlay-in": "overlay-in 150ms ease-out",
        "dialog-in": "dialog-in 150ms ease-out",
        "sheet-in-right": "sheet-in-right 220ms cubic-bezier(0.32, 0.72, 0, 1)",
        "sheet-in-bottom": "sheet-in-bottom 220ms cubic-bezier(0.32, 0.72, 0, 1)",
        "toast-in": "toast-in 150ms ease-out",
      },
    },
  },
  plugins: [],
};

export default config;