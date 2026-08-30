import type { ReactNode } from "react";
import type { Location } from "react-router-dom";
import { RealLocationContext } from "./backgroundLocationContext";

// ═══ «Модальный роут» для десктопной панели задачи (25.08.2026) ═══
//
// TaskDetailPanel.tsx открывает /task/:id ПОВЕРХ списка (Layout.tsx), не
// вместо него — стандартный приём react-router: при клике по задаче на
// широком десктопе (useOpenTask.ts) в history кладётся тот же URL
// /task/:id, но с state.backgroundLocation = тот экран, что был открыт.
// App.tsx рендерит главное дерево <Routes location={background ?? реальный}>
// — то есть ЗА панелью фактически рисуется исходный список, а адресная
// строка честно показывает /task/:id (шарить/обновлять страницу можно,
// упадёт на полноэкранный TaskDetailScreen — тот же самый компонент,
// разницы для него нет).
//
// Подвох: `<Routes location>` подменяет то, что видит useLocation() у ВСЕХ
// потомков этого <Routes> — включая Layout.tsx, который рендерится как раз
// внутри него. Без этого контекста Layout мог бы прочитать через
// useLocation() только ПОДМЕНЁННЫЙ (список) location и никогда бы не узнал,
// что на самом деле открыт /task/:id — то есть панель нечем было бы
// нарисовать. Контекст кладёт РЕАЛЬНЫЙ location (тот, что видит браузер)
// один раз в App.tsx, ДО подмены, и раздаёт его в обход этой подмены —
// см. backgroundLocationContext.ts за useRealLocation()/getOverlayState().
export function RealLocationProvider({
  location,
  children,
}: {
  location: Location;
  children: ReactNode;
}) {
  return (
    <RealLocationContext.Provider value={location}>
      {children}
    </RealLocationContext.Provider>
  );
}
