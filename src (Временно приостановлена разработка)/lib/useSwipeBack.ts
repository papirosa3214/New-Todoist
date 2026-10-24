// ═══════════ СВАЙП «НАЗАД» ОТ ЛЕВОГО КРАЯ ═══════════
//
// 26.08.2026, просьба Максима: «свайп нужно назад добавить, соответственно
// избавиться от этих кнопочек маленьких назад». Системный жест iOS
// (interactivePopGestureRecognizer) внутри WKWebView не работает: там нет
// UINavigationController, история живёт в react-router. Поэтому жест свой.
//
// ═══ Зона захвата — ВЕСЬ экран ═══
//
// Сначала жест ловился только у левого края (24px), чтобы не драться с
// остальными горизонтальными жестами. На живом устройстве это оказалось
// неудобно — Максим 26.08.2026: «можешь сделать не прям с края, а чтобы
// вообще просто по жесту делалось; в списке я всё равно этими свайпами не
// пользуюсь, здесь не нужно назад».
//
// Поэтому свайп вправо работает с любой точки, а места с собственными
// горизонтальными жестами помечены атрибутом data-hswipe и исключаются:
//   - TaskRow — свайп строки влево открывает редактирование;
//   - DayHours / UpcomingCalendar — листание дней;
//   - горизонтальные скроллеры (тулбар редактора).
// Помечать приходится по одному, но зато исключения видны в разметке, а
// не спрятаны в пороге пикселей.
//
// Направление тоже помогает: «назад» — это всегда ВПРАВО, а свайп строки
// задачи в редактирование — влево. Пересекается только «удалить» (вправо),
// поэтому строки и помечены.
//
// ═══ Различение жеста и прокрутки ═══
//
// Тот же принцип, что в TaskRow (см. комментарий про direction lock):
// сначала порог движения DIRECTION_LOCK_PX, и только потом решение об оси,
// причём горизонталь должна ЯВНО преобладать (DIRECTION_BIAS_ANYWHERE), а не
// выигрывать на один пиксель. Цена ошибки несимметрична: принять прокрутку
// за свайп — выкинуть человека с экрана, принять свайп за прокрутку —
// он просто повторит жест.
//
// ═══ Почему это здесь, а не в каждом экране ═══
//
// Хук вешается ОДИН раз в Layout.tsx на общий скроллер — как
// usePullToRefresh. Экраны о нём не знают и ничего не подключают.
import { useEffect, useRef } from "react";
import { hapticGrab } from "./haptics";

/** Насколько сильно горизонталь должна преобладать над вертикалью.
 *  Жест ловится с любой точки экрана, поэтому требование строже, чем было
 *  у краевого варианта: случайно повести пальцем вбок при прокрутке — не
 *  повод улететь с экрана. */
const DIRECTION_BIAS_ANYWHERE = 2;
/** Порог, после которого вообще принимается решение об оси движения. */
const DIRECTION_LOCK_PX = 10;
/** Сколько нужно протащить, чтобы жест сработал (доля ширины экрана). */
const COMMIT_FRACTION = 0.35;
/** Либо резкий бросок — тогда расстояние не важно (px/мс). */
const COMMIT_VELOCITY = 0.5;

interface Gesture {
  active: boolean;
  decided: boolean;
  horizontal: boolean;
  startX: number;
  startY: number;
  lastX: number;
  lastTime: number;
  velocity: number;
}

const IDLE: Gesture = {
  active: false,
  decided: false,
  horizontal: false,
  startX: 0,
  startY: 0,
  lastX: 0,
  lastTime: 0,
  velocity: 0,
};

/**
 * Свайп от левого края = «назад».
 *
 * @param onBack  что делать по завершении жеста (обычно navigate(-1))
 * @param enabled выключается там, где уходить некуда (корневые разделы)
 *
 * Ничего не возвращает: контент за пальцем не едет. Пробовали — шапка
 * внутри сдвинутого контейнера теряет привязку к окну и уезжает вместе с
 * ним (см. комментарий в Layout.tsx).
 */
export function useSwipeBack(onBack: () => void, enabled: boolean): void {
  const gesture = useRef<Gesture>({ ...IDLE });
  // Колбэк в ref: иначе смена navigate на каждом рендере пересоздавала бы
  // слушатели, и жест рвался бы посреди движения.
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (!enabled) return;
    // Слушаем ВЕСЬ экран, а не только скроллер (26.08.2026, Максим:
    // «почему ты добавляешь этот свайп только в какие-то активные окна,
    // почему на фон не добавляешь»). Шапка у нас position:fixed, нижняя
    // панель и FAB — тоже; они лежат ВНЕ скроллера, и жест от края на их
    // высоте не начинался вовсе. Пустой фон под коротким списком — та же
    // история. На документе таких дыр нет.
    const el: HTMLElement | Document = document;

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      const target = t.target as Element | null;
      // Элементы со своим горизонтальным жестом (строка задачи, календарь,
      // горизонтальный скроллер) — не трогаем.
      if (target?.closest?.("[data-hswipe]")) {
        gesture.current = { ...IDLE };
        return;
      }
      // Внутри шторки/диалога «назад» не работает: у модалки свои правила
      // закрытия, и увести из-под неё весь экран — не то, чего ждёт рука.
      // Шторки помечены data-overlay (см. ActionsMenu, Dialog, *Sheet).
      if (target?.closest?.("[data-overlay]")) {
        gesture.current = { ...IDLE };
        return;
      }
      gesture.current = {
        active: true,
        decided: false,
        horizontal: false,
        startX: t.clientX,
        startY: t.clientY,
        lastX: t.clientX,
        lastTime: performance.now(),
        velocity: 0,
      };
    };

    const onTouchMove = (e: TouchEvent) => {
      const g = gesture.current;
      if (!g.active) return;
      const t = e.touches[0];
      const dx = t.clientX - g.startX;
      const dy = t.clientY - g.startY;

      if (!g.decided) {
        if (
          Math.abs(dx) < DIRECTION_LOCK_PX &&
          Math.abs(dy) < DIRECTION_LOCK_PX
        ) {
          return; // ещё рано решать
        }
        g.decided = true;
        // Вправо и явно горизонтально — наш жест. Иначе отдаём прокрутке.
        g.horizontal =
          dx > 0 && Math.abs(dx) > Math.abs(dy) * DIRECTION_BIAS_ANYWHERE;
        if (!g.horizontal) {
          g.active = false;
          return;
        }
        hapticGrab();
      }

      if (!g.horizontal) return;
      // Жест наш — гасим прокрутку, иначе экран поедет и вбок, и вниз.
      e.preventDefault();

      const now = performance.now();
      const dt = now - g.lastTime;
      if (dt > 0) {
        g.velocity = (t.clientX - g.lastX) / dt;
        g.lastX = t.clientX;
        g.lastTime = now;
      }
    };

    const finish = () => {
      const g = gesture.current;
      if (!g.active || !g.horizontal) {
        gesture.current = { ...IDLE };
        return;
      }
      gesture.current = { ...IDLE };
      const dx = g.lastX - g.startX;
      const passed =
        dx > window.innerWidth * COMMIT_FRACTION ||
        g.velocity > COMMIT_VELOCITY;
      if (passed) {
        // Сбрасываем смещение СРАЗУ, до навигации, а не доводим экран до
        // края с задержкой.
        //
        // Так было (26.08.2026, поймано на живом устройстве): setOffset на
        // всю ширину экрана + сброс через 350мс. Красиво в теории, на деле
        // — новый экран успевал отрисоваться ВНУТРИ ещё сдвинутого
        // контейнера и уезжал вправо вместе с шапкой. А шапка у нас
        // position:fixed, и по спецификации fixed внутри элемента с
        // transform привязывается к ЭТОМУ элементу, а не к окну — то есть
        // уходила за край экрана целиком. Максим: «пропадает оглавление
        // Дневник и верхние три точки».
        //
        // Уход и так читается сменой самого экрана, доводка не нужна.
        onBackRef.current();
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    // passive:false — внутри вызываем preventDefault, чтобы отобрать жест
    // у прокрутки.
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", finish, { passive: true });
    el.addEventListener("touchcancel", finish, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", finish);
      el.removeEventListener("touchcancel", finish);
    };
  }, [enabled]);
}
