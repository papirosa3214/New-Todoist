import { useEffect, useState } from "react";

function useMinWidth(breakpoint: number) {
  const [v, setV] = useState(
    typeof window !== "undefined" ? window.innerWidth >= breakpoint : false,
  );
  useEffect(() => {
    const onResize = () => setV(window.innerWidth >= breakpoint);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return v;
}

// Брейкпоинт — Tailwind `lg` (1024px), не `md` (768px, старое значение
// здесь). Ниже 1024 остаётся мобильная раскладка (single-column, полная
// ширина вьюпорта) — это осознанно шире, чем «телефон», и накрывает узкие
// ноутбучные окна/таблеты в портретной ориентации: до этой правки такое
// окно попадало в старую desktop-ветку и получало 390px рамку с мёртвым
// полем вокруг — то есть уже тогда фактически показывало «мобильный» вид,
// просто через фейковую рамку вместо честной полноширинной раскладки.
// Приложение мобильное по духу (см. задание), поэтому граница поставлена
// консервативно: только экраны, где реально помещается боковая колонка
// навигации + читаемая колонка контента (см. desktop-ветку Layout.tsx),
// получают десктопный вид.
export function useIsMobile() {
  return !useMinWidth(1024);
}

// Мастер-деталь (список слева + карточка задачи справа, Layout.tsx +
// TaskDetailPanel.tsx, 25.08.2026, «сделай как Linear и Todoist») требует
// места на три колонки разом: SideNav (240px, фикс) + список (гибкий) +
// панель задачи (460px, фикс — под ту же 390px-вёрстку TaskDetailScreen,
// что и на телефоне). На 1024–1279px десктоп-ветка уже есть (SideNav +
// список), но втроём не помещаются читаемо — там клик по задаче остаётся
// полноэкранной навигацией, как на мобильном (см. useOpenTask.ts). 1280 —
// тот же порог, что у dev-панели «Экраны · Референсы» (`xl:` в Tailwind),
// была отдельным сигналом «здесь уже настоящий десктоп».
export function useDesktopPanelEligible() {
  return useMinWidth(1280);
}
