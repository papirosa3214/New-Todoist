// ═══════════ useMultiSpring ═══════════
// N независимых пружин на ОДНОМ requestAnimationFrame-цикле. Физика — то же
// semi-implicit Euler с критическим демпфированием, что в useSpring.ts,
// один в один, просто на массиве вместо скаляра. Не расширение самого
// useSpring.ts (его трогать незачем — им уже пользуется ActionsMenu.tsx) и
// не N раздельных вызовов useSpring() в цикле (нарушает Rules of Hooks —
// число хуков должно быть одинаковым на каждый рендер, а не зависеть от
// длины items).
//
// Нужен FanMenu.tsx: у каждого пункта веера — своя пружина (стаггер при
// открытии, независимое движение), но один общий rAF-цикл дешевле N
// отдельных.

import { useRef, useEffect } from "react";
import type { SpringOptions } from "./useSpring";

export interface MultiSpringHandle {
  /** Анимировать пункт index из текущей позиции к target. */
  animateTo(index: number, target: number, initialVelocity?: number): void;
  /** Мгновенно выставить значение без анимации. */
  set(index: number, value: number): void;
  /** Текущее положение пункта. */
  current(index: number): number;
}

export function useMultiSpring(
  count: number,
  onUpdate: (index: number, value: number, done: boolean) => void,
  opts: SpringOptions = {},
): MultiSpringHandle {
  const cbRef = useRef(onUpdate);
  cbRef.current = onUpdate;

  const optsRef = useRef(opts);
  optsRef.current = opts;

  const state = useRef<{
    values: Float64Array;
    vels: Float64Array;
    targets: Float64Array;
    active: Uint8Array; // 1 — ещё двигается, 0 — уже done
    rafId: ReturnType<typeof requestAnimationFrame> | null;
    lastTime: number | null;
  } | null>(null);

  if (!state.current || state.current.values.length !== count) {
    // Пересоздание массивов на смену count обрывает любой идущий rAF-цикл
    // старого state — не отменить его rafId здесь значило бы потерять
    // ссылку на активный requestAnimationFrame навсегда (он всё равно
    // сработает ещё раз на старом объекте и тихо остановится сам — не
    // крэш, но лишний кадр и незакрытый id, пока жив компонент).
    if (state.current?.rafId !== null && state.current?.rafId !== undefined) {
      cancelAnimationFrame(state.current.rafId);
    }
    state.current = {
      values: new Float64Array(count),
      vels: new Float64Array(count),
      targets: new Float64Array(count),
      active: new Uint8Array(count),
      rafId: null,
      lastTime: null,
    };
  }

  const handle = useRef<MultiSpringHandle | null>(null);

  if (!handle.current) {
    const tick = (ts: number) => {
      const s = state.current!;
      const dt =
        s.lastTime !== null
          ? Math.min((ts - s.lastTime) / 1000, 0.064)
          : 1 / 60;
      s.lastTime = ts;

      const response = optsRef.current.response ?? 0.35;
      const damping = optsRef.current.damping ?? 1;
      const omega = (2 * Math.PI) / response;
      const k = omega * omega;
      const c = 2 * damping * omega;

      let anyActive = false;
      for (let i = 0; i < s.values.length; i++) {
        if (!s.active[i]) continue;
        const acc = k * (s.targets[i] - s.values[i]) - c * s.vels[i];
        s.vels[i] += acc * dt;
        s.values[i] += s.vels[i] * dt;

        const done =
          Math.abs(s.targets[i] - s.values[i]) < 0.002 &&
          Math.abs(s.vels[i]) < 0.02;

        if (done) {
          s.values[i] = s.targets[i];
          s.vels[i] = 0;
          s.active[i] = 0;
          cbRef.current(i, s.values[i], true);
        } else {
          anyActive = true;
          cbRef.current(i, s.values[i], false);
        }
      }

      if (anyActive) {
        s.rafId = requestAnimationFrame(tick);
      } else {
        s.rafId = null;
        s.lastTime = null;
      }
    };

    const ensureLoop = () => {
      const s = state.current!;
      if (s.rafId === null) {
        s.lastTime = null;
        s.rafId = requestAnimationFrame(tick);
      }
    };

    handle.current = {
      animateTo(index, target, initialVelocity) {
        const s = state.current!;
        s.targets[index] = target;
        if (initialVelocity !== undefined) s.vels[index] = initialVelocity;
        s.active[index] = 1;
        ensureLoop();
      },
      set(index, value) {
        const s = state.current!;
        s.values[index] = value;
        s.vels[index] = 0;
        s.targets[index] = value;
        s.active[index] = 0;
        cbRef.current(index, value, true);
      },
      current(index) {
        return state.current!.values[index];
      },
    };
  }

  useEffect(() => {
    // state.current читаем ВНУТРИ cleanup, не захватываем при монтировании:
    // при смене count (см. resize-ветка выше) объект целиком заменяется, а
    // этот эффект с пустыми deps выполняется один раз — захват на монтаже
    // отменил бы rafId уже покинутого объекта, а актуальный цикл остался бы
    // висеть после размонтирования компонента.
    return () => {
      const s = state.current;
      if (s && s.rafId !== null) cancelAnimationFrame(s.rafId);
    };
  }, []);

  return handle.current;
}
