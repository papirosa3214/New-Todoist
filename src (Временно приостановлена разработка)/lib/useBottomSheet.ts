// ═══════════ useBottomSheet ═══════════
// Единый хук для всех bottom sheet в приложении. Реализует:
//
// §1 Response: анимация стартует мгновенно при open=true.
// §2 Direct manipulation: drag 1:1 отслеживает палец (setPointerCapture).
// §3 Interruptibility: drag останавливает spring без прыжка, spring
//    продолжает от текущей позиции.
// §5 Velocity handoff: скорость пальца при pointerup передаётся в spring.
// §7 Spatial consistency: sheet всегда входит и выходит снизу (одна ось Y).
// §8 Hint in direction: handle-бар намекает «можно потянуть вниз».
//
// Стили применяются прямо в DOM через .style — ноль React re-render'ов
// во время анимации. Только два setState: mounted=true при открытии
// и mounted=false когда анимация закрытия завершена.
//
// Использование:
//   const sheet = useBottomSheet({ open, onClose });
//   if (!sheet.mounted) return null;
//   return (
//     <div ref={sheet.containerRef} className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
//       <div ref={sheet.scrimRef} className="absolute inset-0 bg-black" style={{ opacity: 0 }} />
//       <div ref={sheet.sheetRef} className="relative bg-card ..." onClick={e => e.stopPropagation()}>
//         <SheetHandle dragProps={sheet.dragProps} />
//         ...
//       </div>
//     </div>
//   );

import {
  useRef,
  useState,
  useEffect,
  useCallback,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useSpring } from "./useSpring";

const SCRIM_OPACITY = 0.65;
// Свайп вниз считается «dismiss», если скорость > этого порога (px/s)...
const DISMISS_VELOCITY = 500;
// ...или смещение > этой доли высоты шита
const DISMISS_FRACTION = 0.4;

interface VelocitySample {
  y: number;
  t: number;
}

export interface BottomSheetDragProps {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  style: { touchAction: "none"; cursor: "grab" };
}

export interface BottomSheetHandle {
  mounted: boolean;
  sheetRef: RefObject<HTMLDivElement | null>;
  scrimRef: RefObject<HTMLDivElement | null>;
  /** Attach to the drag-handle element */
  dragProps: BottomSheetDragProps;
}

export function useBottomSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): BottomSheetHandle {
  const [mounted, setMounted] = useState(false);

  const sheetRef = useRef<HTMLDivElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Флаг: пользователь сам свайпнул — spring вызовет onClose при завершении,
  // чтобы не запустить вторую анимацию закрытия из useEffect ниже.
  const isDismissingRef = useRef(false);

  // Флаг: спринг сейчас реально едет К ЗАКРЫТИЮ (props-close ИЛИ
  // drag-dismiss) — единственный случай, когда done-коллбэк ниже должен
  // унмаунтить шит. Без этого флага баг 17.08.2026 («нажимаешь «Перенести»,
  // шит вообще не открывается»): spring.set(h) в открывающем useEffect ниже
  // — это МГНОВЕННАЯ установка стартовой позиции («съехать вниз перед
  // стартом анимации вверх»), не связанная с закрытием, но useSpring.set()
  // по контракту сама зовёт onUpdate(value, done:true) синхронно — тот же
  // коллбэк, что и у настоящего конца closing-анимации. При value===h
  // (а это всегда так сразу после spring.set(h)) условие "докатились до
  // низа" было неотличимо от "закрытие завершилось" → setMounted(false)
  // срабатывал в тот же тик, что и открытие, отменяя requestAnimationFrame
  // ниже (cleanup эффекта при [mounted] true→false его отменяет) — шит
  // монтировался и тут же размонтировался в одном цикле рендера.
  const isClosingRef = useRef(false);

  // Кэшированная высота шита — измеряется один раз при монтировании
  // и переизмеряется при ресайзе (ResizeObserver ниже).
  const heightRef = useRef(0);

  // Применить translateY и пропорциональную прозрачность скрима
  const applyY = useCallback((y: number) => {
    const sheet = sheetRef.current;
    const scrim = scrimRef.current;
    if (sheet) sheet.style.transform = `translateY(${y}px)`;
    if (scrim) {
      const h = heightRef.current || 1;
      const fraction = Math.min(Math.max(1 - y / h, 0), 1);
      scrim.style.opacity = String(fraction * SCRIM_OPACITY);
    }
  }, []);

  const spring = useSpring(
    (value, done) => {
      applyY(value);
      // isClosingRef.current — см. комментарий у объявления: без него сюда
      // попадает и мгновенная стартовая установка позиции при открытии.
      if (done && isClosingRef.current) {
        const h = heightRef.current;
        if (value >= h - 1) {
          // Анимация закрытия действительно завершена
          isClosingRef.current = false;
          if (isDismissingRef.current) {
            isDismissingRef.current = false;
            onCloseRef.current();
          }
          setMounted(false);
        }
      }
    },
    { response: 0.35, damping: 1 },
  );

  // Открытие: mount → rAF → start animation
  const justMountedRef = useRef(false);
  useEffect(() => {
    if (open) {
      isDismissingRef.current = false;
      isClosingRef.current = false;
      justMountedRef.current = true;
      setMounted(true);
    } else {
      // Закрытие через props (кнопка «×», клик по скриму и т.д.)
      if (!mounted) return;
      if (isDismissingRef.current) return; // уже анимируется drag-dismiss
      isClosingRef.current = true;
      const h = heightRef.current || (sheetRef.current?.offsetHeight ?? 600);
      spring.animateTo(h, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // После того как setMounted(true) прошло и компонент отрисовался —
  // измерить высоту и запустить slide-up анимацию.
  useEffect(() => {
    if (!mounted) return;
    if (!justMountedRef.current) return;
    justMountedRef.current = false;

    const sheet = sheetRef.current;
    if (!sheet) return;

    const h = sheet.offsetHeight;
    heightRef.current = h;

    // Начать снизу
    spring.set(h);
    applyY(h);

    // Следующий кадр — animate up
    const raf = requestAnimationFrame(() => {
      spring.animateTo(0);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  // Обновлять height при ресайзе (например, появление клавиатуры)
  useEffect(() => {
    if (!mounted) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    const ro = new ResizeObserver(() => {
      heightRef.current = sheet.offsetHeight;
    });
    ro.observe(sheet);
    return () => ro.disconnect();
  }, [mounted]);

  // ── Drag to dismiss ──────────────────────────────────────────────────────
  const samplesRef = useRef<VelocitySample[]>([]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      // Только основная кнопка / тач
      if (e.button !== 0 && e.pointerType === "mouse") return;

      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      spring.stop();

      const startY = e.clientY;
      const startTranslate = spring.current();
      samplesRef.current = [{ y: e.clientY, t: performance.now() }];

      const onMove = (ev: PointerEvent) => {
        const dy = Math.max(0, ev.clientY - startY);
        const newY = startTranslate + dy;
        applyY(newY);
        // Обновить velocity-историю (последние 6 сэмплов)
        samplesRef.current.push({ y: ev.clientY, t: performance.now() });
        if (samplesRef.current.length > 6) samplesRef.current.shift();
      };

      const onUp = () => {
        el.releasePointerCapture(e.pointerId);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);

        const currentY = spring.current();
        const h = heightRef.current || (sheetRef.current?.offsetHeight ?? 600);

        // Вычислить скорость по двум последним сэмплам
        const samples = samplesRef.current;
        let vel = 0;
        if (samples.length >= 2) {
          const last = samples[samples.length - 1];
          const prev = samples[samples.length - 2];
          const dt = (last.t - prev.t) / 1000;
          if (dt > 0) vel = (last.y - prev.y) / dt;
        }

        const shouldDismiss =
          vel > DISMISS_VELOCITY || currentY > h * DISMISS_FRACTION;

        if (shouldDismiss) {
          // Velocity handoff: spring стартует с реальной скоростью пальца
          isDismissingRef.current = true;
          isClosingRef.current = true;
          spring.animateTo(h, vel);
        } else {
          // Отпустили, не дотянув до порога — едем обратно вверх, это НЕ
          // закрытие: isClosingRef здесь специально не трогаем.
          spring.animateTo(0, vel);
        }
      };

      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const dragProps: BottomSheetDragProps = {
    onPointerDown,
    style: { touchAction: "none", cursor: "grab" },
  };

  return { mounted, sheetRef, scrimRef, dragProps };
}
