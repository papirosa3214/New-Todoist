import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Финансы — личный кабинет",
  description: "Учёт личных финансов: операции, импорт, аналитика",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}