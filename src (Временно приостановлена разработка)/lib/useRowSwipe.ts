// ═══════════ СВАЙП СТРОКИ: изменить / удалить ═══════════
//
// 26.08.2026, Максим про экран проектов: «раз проекты сразу открываются
// списком, то вот это вот „изменить, удалить“, которые иконки стоят, имеет
// смысл точно так же обозначить свайпами, которые у нас уже есть».
//
// Механика списана с TaskRow.tsx — там она вылизана на живом устройстве.
// Здесь то же самое, но вынесено в хук, чтобы не копировать三 раза (проекты,
// метки, что дальше попросят). TaskRow на хук НЕ переводил намеренно: там
// свайп сплетён с чекбоксом, длинным нажатием и подтверждением удаления,
// и переписывание рабочего кода ради красоты — лишний риск.
//
// ═══ Что важно ═══
//
// 1. Направление решается ПОСЛЕ порога в 8px и только если горизонталь явно
//    преобладает (×1.3). Иначе обычная прокрутка списка, где палец дрогнул
//    вбок, открывала бы действия.
// 2. setPointerCapture — палец может уйти за пределы строки, движение всё
//    равно наше.
// 3. Открытая строка закрывается тем же свайпом обратно.
// 4. Резина за пределом раскрытия: тянется, но всё туже.
// 5. Строки помечены data-hswipe — иначе свайп «назад» (useSwipeBack, ловит
//    по всему экрану) перехватывал бы это движение.
import { useCallback, useRef, useState } from "react";
import { hapticCross, hapticDrop } from "./haptics";

/** Ширина открывающейся панели действия. Как в TaskRow. */
export const ROW_ACTION_W = 88;
const DIRECTION_LOCK_PX = 8;
const DIRECTION_BIAS = 1.3;
/** Смещение, после которого строка остаётся открытой. */
const OPEN_PX = 36;
/** Либо скорость броска (px/с). */
const OPEN_VEL = 280;

interface Drag {
  active: boolean;
  locked: boolean;
  isHorizontal: boolean;
  startX: number;
  startY: number;
  startOffset: number;
  lastX: number;
  lastTime: number;
  velocity: number;
}

/**
 * Свайп строки с действиями по краям.
 *
 * @param hasLeft  есть ли действие слева (свайп ВПРАВО открывает его —
 *                 по конвенции проекта это «Удалить»)
 * @param hasRight есть ли действие справа (свайп ВЛЕВО — «Изменить»)
 */
export function useRowSwipe(hasLeft: boolean, hasRight: boolean) {
  const [x, setX] = useState(0);
  const [animate, setAnimate] = useState(false);
  const currentX = useRef(0);
  const drag = useRef<Drag>({
    active: false,
    locked: false,
    isHorizontal: false,
    startX: 0,
    startY: 0,
    startOffset: 0,
    lastX: 0,
    lastTime: 0,
    velocity: 0,
  });

  const move = useCallback((pos: number, withAnimation: boolean) => {
    currentX.current = pos;
    setAnimate(withAnimation);
    setX(pos);
  }, []);

  const close = useCallback(() => move(0, true), [move]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const el = e.currentTarget;
      drag.current = {
        active: true,
        locked: false,
        isHorizontal: false,
        startX: e.clientX,
        startY: e.clientY,
        startOffset: currentX.current,
        lastX: e.clientX,
        lastTime: performance.now(),
        velocity: 0,
      };

      const onMove = (ev: PointerEvent) => {
        const d = drag.current;
        if (!d.active) return;
        const dx = ev.clientX - d.startX;
        const dy = ev.clientY - d.startY;

        if (
          !d.locked &&
          (Math.abs(dx) > DIRECTION_LOCK_PX || Math.abs(dy) > DIRECTION_LOCK_PX)
        ) {
          d.isHorizontal = Math.abs(dx) > Math.abs(dy) * DIRECTION_BIAS;
          d.locked = true;
          if (d.isHorizontal) {
            el.setPointerCapture(ev.pointerId);
            hapticCross();
          }
        }
        if (!d.locked || !d.isHorizontal) return;

        const now = performance.now();
        const dt = (now - d.lastTime) / 1000;
        if (dt > 0.005) {
          d.velocity = (ev.clientX - d.lastX) / dt;
          d.lastX = ev.clientX;
          d.lastTime = now;
        }

        let raw = d.startOffset + dx;
        // В сторону, где действия нет, не пускаем вовсе.
        if (raw > 0 && !hasLeft) raw = 0;
        if (raw < 0 && !hasRight) raw = 0;

        let pos = raw;
        if (raw > ROW_ACTION_W) {
          const over = raw - ROW_ACTION_W;
          pos = ROW_ACTION_W + (over * 30) / (30 + over);
        } else if (raw < -ROW_ACTION_W) {
          const over = -raw - ROW_ACTION_W;
          pos = -ROW_ACTION_W - (over * 30) / (30 + over);
        }
        move(pos, false);
      };

      const onUp = (ev: PointerEvent) => {
        const d = drag.current;
        d.active = false;
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
        if (!d.isHorizontal) return;

        const dx = ev.clientX - d.startX;
        const pos = currentX.current;
        const vel = d.velocity;

        if (d.startOffset === 0) {
          if (hasRight && (pos < -OPEN_PX || vel < -OPEN_VEL)) {
            hapticDrop();
            move(-ROW_ACTION_W, true);
          } else if (hasLeft && (pos > OPEN_PX || vel > OPEN_VEL)) {
            hapticDrop();
            move(ROW_ACTION_W, true);
          } else {
            move(0, true);
          }
        } else if (d.startOffset < 0) {
          // Уже открыто справа — закрываем встречным движением.
          const keep = !(dx > 25 || vel > 250);
          move(keep ? -ROW_ACTION_W : 0, true);
        } else {
          const keep = !(dx < -25 || vel < -250);
          move(keep ? ROW_ACTION_W : 0, true);
        }
      };

      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    },
    [hasLeft, hasRight, move],
  );

  return {
    /** Текущее смещение строки. */
    x,
    /** Нужно ли анимировать смещение (на время жеста — нет). */
    animate,
    /** Открыта ли строка и с какой стороны. */
    side: x > 1 ? ("left" as const) : x < -1 ? ("right" as const) : null,
    onPointerDown,
    close,
  };
}
