import { useRef } from "react";

// На сколько палец может уехать, чтобы жест всё ещё считался тапом.
// 10 CSS-пикселей — тот же гистерезис, что Apple закладывает в
// распознавание тапа (skill apple-design, «Gesture design details»): меньше
// — и обычное дрожание пальца отменяло бы нажатие, больше — прокрутка
// успевает восприниматься как тап.
const TAP_SLOP = 10;

/**
 * Тап — это нажатие БЕЗ движения.
 *
 * Жалоба Максима 20.08.2026: «в канбане хочу свайпнуть, палец, разумеется,
 * попадает на карточку, и как только я отжимаю — меня тут же перекидывает
 * в эту карточку». Так и есть: карточка — обычная кнопка, а браузер шлёт
 * `click` по отпусканию независимо от того, ехал палец или нет. Прокрутка
 * колонок вбок и страницы вниз начинается пальцем, лежащим на карточке, —
 * значит каждый второй свайп заканчивался открытием задачи.
 *
 * Здесь тап подтверждается только если палец не ушёл дальше TAP_SLOP.
 * Иначе клик гасится — гасится именно клик, не сам жест: прокрутка при
 * этом идёт как шла, обработчик ничего не перехватывает и ничего не
 * отменяет.
 *
 * Применение — разложить на тот же элемент, что несёт onClick:
 *
 *   const tap = useTapGuard(() => navigate(...));
 *   <button {...tap}>…</button>
 */
export function useTapGuard(onTap: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);

  return {
    onPointerDown: (e: React.PointerEvent) => {
      start.current = { x: e.clientX, y: e.clientY };
      moved.current = false;
    },
    onPointerMove: (e: React.PointerEvent) => {
      const from = start.current;
      if (!from || moved.current) return;
      if (
        Math.abs(e.clientX - from.x) > TAP_SLOP ||
        Math.abs(e.clientY - from.y) > TAP_SLOP
      ) {
        moved.current = true;
      }
    },
    // Прокрутка контейнера может увести содержимое из-под неподвижного
    // пальца — тогда pointermove не приходит вовсе, а `click` всё равно
    // будет. Отмена прокруткой (pointercancel шлёт браузер, когда забирает
    // жест себе) — тоже «не тап».
    onPointerCancel: () => {
      moved.current = true;
    },
    onClick: (e: React.MouseEvent) => {
      if (moved.current) {
        e.preventDefault();
        e.stopPropagation();
        moved.current = false;
        return;
      }
      onTap();
    },
  };
}
