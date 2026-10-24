// ═══════════ useSpring ═══════════
// Минималистичный spring-контроллер на requestAnimationFrame.
// Никаких зависимостей, без React state — стили применяются прямо в DOM.
//
// Принципы (Apple Design SKILL §3-5):
// • Прерываемость: animateTo() из любой точки начинает от текущего значения
//   с текущей скоростью, без прыжков.
// • Velocity handoff: initialVelocity передаёт скорость пальца при release.
// • Критическое демпфирование (damping=1): плавное замедление без оверхутa,
//   если только не передан damping < 1 для физических бросков.
//
// Формула: semi-implicit Euler, ω = 2π/response, k = ω², c = 2·ζ·ω.
// «response» — аналог Apple's response parameter: за сколько секунд пружина
// добирается до цели. НЕ duration (у пружины нет фиксированного времени).

import { useRef, useEffect } from "react";

export interface SpringOptions {
  /** Секунды до «осмысленного» приближения к цели. Default 0.35 */
  response?: number;
  /** 0 = нет затухания, 1 = критическое (без оверхута). Default 1 */
  damping?: number;
}

export interface SpringHandle {
  /** Анимировать из текущей позиции к target с опциональным initialVelocity
   *  (px/s). Третьим аргументом можно задать упругость ИМЕННО этого броска:
   *  Apple Design §4 — оверхут уместен только когда жест сам нёс инерцию
   *  (флик), и неуместен, когда элемент просто возвращается на место. */
  animateTo(
    target: number,
    initialVelocity?: number,
    opts?: SpringOptions,
  ): void;
  /** Мгновенно выставить значение без анимации */
  set(value: number): void;
  /** Остановить rAF-цикл */
  stop(): void;
  /** Текущее положение */
  current(): number;
  /** Текущая скорость (px/s) */
  velocity(): number;
}

export function useSpring(
  onUpdate: (value: number, done: boolean) => void,
  opts: SpringOptions = {},
): SpringHandle {
  // Всегда актуальный callback без лишних перезапусков
  const cbRef = useRef(onUpdate);
  cbRef.current = onUpdate;

  const state = useRef({
    value: 0,
    vel: 0,
    target: 0,
    rafId: null as ReturnType<typeof requestAnimationFrame> | null,
    lastTime: null as number | null,
    response: opts.response ?? 0.35,
    damping: opts.damping ?? 1,
  });

  const handle = useRef<SpringHandle | null>(null);

  if (!handle.current) {
    const tick = (ts: number) => {
      const s = state.current;
      const dt =
        s.lastTime !== null
          ? Math.min((ts - s.lastTime) / 1000, 0.064) // cap at ~2 кадра
          : 1 / 60;
      s.lastTime = ts;

      const omega = (2 * Math.PI) / s.response;
      const k = omega * omega;
      const c = 2 * s.damping * omega;

      const acc = k * (s.target - s.value) - c * s.vel;
      s.vel += acc * dt;
      s.value += s.vel * dt;

      // «Готово» когда близко и почти не движется
      const done = Math.abs(s.target - s.value) < 0.5 && Math.abs(s.vel) < 2;

      if (done) {
        s.value = s.target;
        s.vel = 0;
        s.rafId = null;
        cbRef.current(s.value, true);
      } else {
        s.rafId = requestAnimationFrame(tick);
        cbRef.current(s.value, false);
      }
    };

    handle.current = {
      animateTo(target, initialVelocity, o) {
        const s = state.current;
        if (s.rafId !== null) cancelAnimationFrame(s.rafId);
        s.target = target;
        s.lastTime = null;
        if (o?.response !== undefined) s.response = o.response;
        if (o?.damping !== undefined) s.damping = o.damping;
        if (initialVelocity !== undefined) s.vel = initialVelocity;
        s.rafId = requestAnimationFrame(tick);
      },
      set(value) {
        const s = state.current;
        if (s.rafId !== null) {
          cancelAnimationFrame(s.rafId);
          s.rafId = null;
        }
        s.value = value;
        s.vel = 0;
        s.target = value;
        s.lastTime = null;
        cbRef.current(value, true);
      },
      stop() {
        const s = state.current;
        if (s.rafId !== null) {
          cancelAnimationFrame(s.rafId);
          s.rafId = null;
        }
      },
      current() {
        return state.current.value;
      },
      velocity() {
        return state.current.vel;
      },
    };
  }

  // Синхронизируем параметры (без перезапуска анимации)
  useEffect(() => {
    state.current.response = opts.response ?? 0.35;
    state.current.damping = opts.damping ?? 1;
  }, [opts.response, opts.damping]);

  // Cleanup при размонтировании компонента
  useEffect(() => {
    const h = handle.current;
    return () => h?.stop();
  }, []);

  return handle.current;
}
