import { Routes, Route, type Location } from "react-router-dom";
import { TaskDetailScreen } from "../screens/TaskDetailScreen";

// Правая панель мастер-деталь (Layout.tsx, десктоп ≥1280px) — задача поверх
// списка, а не отдельный экран, «как Linear и Todoist» (владелец,
// 25.08.2026). Внутри — тот же TaskDetailScreen, что и на телефоне/узком
// десктопе, без переделки под панель: его ScreenHeader сам меряет ширину
// через ближайшего скроллящегося предка (UI.tsx, useFullBleedInset —
// findScrollContainer идёт вверх до первого overflow-y:auto/scroll) и сам
// собой ужмётся до ширины ЭТОЙ панели, а не всего окна — тот приём был
// заведён как раз ради вложенных скролл-контейнеров, годится и здесь без
// правок. Кнопка «←» в его шапке уже делает navigate(-1) — для панели это
// и есть «закрыть»: тот же самый пуш в историю, что открыл её (см.
// useOpenTask.ts), схлопывается обратно.
//
// Вложенный <Routes> — не дублирование всей таблицы маршрутов из App.tsx,
// а единственный способ дать TaskDetailScreen рабочий useParams().id: сам
// компонент не принимает id пропом, читает его из параметров маршрута.
// Без Routes/Route здесь он оказался бы вне матчинга и увидел бы пустые
// параметры. location передаётся РЕАЛЬНЫЙ (не тот, что подменяет App.tsx
// для фона) — именно в нём лежит /task/:id.
export function TaskDetailPanel({ location }: { location: Location }) {
  return (
    <div className="hidden xl:flex flex-col w-[460px] shrink-0 h-full border-l border-stroke overflow-y-auto overflow-x-hidden overscroll-y-contain">
      <Routes location={location}>
        <Route path="/task/:id" element={<TaskDetailScreen />} />
      </Routes>
    </div>
  );
}
