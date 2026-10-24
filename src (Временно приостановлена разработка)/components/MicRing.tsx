import { useEffect, useRef } from "react";

// ═══════════ Радиальное кольцо — визуализация голоса вокруг микрофона ═══════════
//
// Owner 2026-08-13: перенос готового виджета, присланного файлом
// `voice-ring-2.html` (Dropbox AI) — «не надо ничего исправлять, взять
// именно то, что скинул». Вся арифметика ниже (константы, hash-функции
// личности каждой палочки, LERP-сглаживание, тройной синус) — 1:1 копия
// из этого файла, НЕ переизобретена. Единственное сознательное отличие от
// присланного файла — сама круглая mic-кнопка (там: 88px, свой фон/бордер/
// box-shadow) заменена на children: владелец явно попросил «не кнопку из
// файла, а нашу плоскую иконку, только кружочек аккуратно впиши» — кольцо
// оборачивает существующую кнопку TaskFormScreen, не заменяет её.
//
// Почему предыдущая версия (MicWaveform, canvas-осциллограмма) выглядела
// «как струна натянутая»: рисовала сырые time-domain сэмплы без всякого
// сглаживания. Здесь этого не происходит — see LERP ниже — каждая палочка
// плавно едет к своей цели, а не дёргается на каждый кадр вслед за сырым
// сигналом.
const NUM_BARS = 96; // количество палочек в кольце
const RING_RADIUS_RATIO = 0.36; // доля радиуса от canvas
const BASE_LENGTH = 5; // базовая длина (кольцо всегда замкнуто)
const AUDIO_GAIN = 17; // насколько палочка вытягивается от голоса
const BAR_WIDTH = 2; // толщина палочки
const LERP = 0.15; // плавность (0..1, меньше = плавнее)
// Owner 2026-08-13: «надо орать, чтобы хоть как-то поднялись... должны
// реагировать на шёпот уже достаточно энергично» — исходное значение файла
// (3.2) давало почти незаметную реакцию на обычную речь через веб-микрофон.
// Поднято в разы (15, не микро-твик) + гамма-коррекция ниже (Math.sqrt) —
// подтягивает тихие сигналы сильнее, чем линейный gain: обычная типичная
// RMS шёпота через getUserMedia без явного constraint на gain (используемый
// здесь — {audio:true} без autoGainControl/gain override) — порядка
// 0.005–0.02, обычной речи — 0.03–0.08. Подобрано расчётом под эти
// диапазоны, не протестировано на реальном микрофоне живьём — если
// по-прежнему мало/слишком много, число легко подкрутить одной строкой.
const VOLUME_GAIN = 15;
const WAVE_SPEED = 1.6; // скорость «движения» волны по кольцу

export function MicRing({
  active,
  getTimeDomainData,
  children,
}: {
  active: boolean;
  getTimeDomainData: () => Uint8Array | null;
  children: React.ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // rAF-цикл читает актуальность через ref, не через замыкание над props —
  // цикл запускается ОДИН раз при монтировании и живёт постоянно (как в
  // оригинале: update() гоняется с первого кадра страницы, не
  // старт/стоп-привязан к записи) — иначе LERP-затухание кольца в состояние
  // покоя при остановке записи не успевало бы доиграть до конца.
  const activeRef = useRef(active);
  activeRef.current = active;
  const getDataRef = useRef(getTimeDomainData);
  getDataRef.current = getTimeDomainData;

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let dpr = window.devicePixelRatio || 1;
    let cx = 0;
    let cy = 0;
    let radius = 0;

    function resizeCanvas() {
      dpr = window.devicePixelRatio || 1;
      const rect = wrap!.getBoundingClientRect();
      canvas!.width = Math.floor(rect.width * dpr);
      canvas!.height = Math.floor(rect.height * dpr);
      canvas!.style.width = rect.width + "px";
      canvas!.style.height = rect.height + "px";
      ctx!.setTransform(1, 0, 0, 1, 0, 0);
      ctx!.scale(dpr, dpr);
      cx = rect.width / 2;
      cy = rect.height / 2;
      radius = rect.width * RING_RADIUS_RATIO;
    }
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);

    // === Bar personalities ===
    // Каждая палочка получает свою фазу, скорость и «характер» — без
    // привязки к частотам. Получается «эквалайзер», который живой и
    // непредсказуемый, а не линейная развёртка спектра.
    const BAR_PHASE = new Float32Array(NUM_BARS);
    const BAR_SPEED = new Float32Array(NUM_BARS);
    const BAR_BIAS = new Float32Array(NUM_BARS);
    for (let i = 0; i < NUM_BARS; i++) {
      const h1 = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
      const h2 = Math.sin(i * 39.346 + 11.135) * 43758.5453;
      const h3 = Math.sin(i * 91.713 + 47.281) * 43758.5453;
      BAR_PHASE[i] = (h1 - Math.floor(h1)) * Math.PI * 2; // 0..2π
      BAR_SPEED[i] = 0.35 + (h2 - Math.floor(h2)) * 0.95; // 0.35..1.30
      BAR_BIAS[i] = 0.45 + (h3 - Math.floor(h3)) * 0.55; // 0.45..1.00
    }

    const bars = new Array(NUM_BARS).fill(0);
    const targets = new Array(NUM_BARS).fill(0);

    function draw() {
      const w = canvas!.width / dpr;
      const h = canvas!.height / dpr;
      ctx!.clearRect(0, 0, w, h);

      for (let i = 0; i < NUM_BARS; i++) {
        const angle = (i / NUM_BARS) * Math.PI * 2 - Math.PI / 2;
        const len = bars[i];
        const audioPart = Math.max(0, len - BASE_LENGTH);
        const intensity = Math.min(1, audioPart / AUDIO_GAIN);

        const x1 = cx + Math.cos(angle) * radius;
        const y1 = cy + Math.sin(angle) * radius;
        const x2 = cx + Math.cos(angle) * (radius + len);
        const y2 = cy + Math.sin(angle) * (radius + len);

        const alpha = 0.5 + intensity * 0.5;

        // Палочка
        ctx!.strokeStyle = `rgba(239, 68, 68, ${alpha})`;
        ctx!.lineWidth = BAR_WIDTH + intensity * 1.2;
        ctx!.lineCap = "round";
        ctx!.beginPath();
        ctx!.moveTo(x1, y1);
        ctx!.lineTo(x2, y2);
        ctx!.stroke();

        // Мягкое свечение на кончике (только когда есть аудио)
        if (intensity > 0.2) {
          const gr = 3 + intensity * 5;
          const grad = ctx!.createRadialGradient(x2, y2, 0, x2, y2, gr);
          grad.addColorStop(0, `rgba(239, 68, 68, ${intensity * 0.45})`);
          grad.addColorStop(1, `rgba(239, 68, 68, 0)`);
          ctx!.fillStyle = grad;
          ctx!.beginPath();
          ctx!.arc(x2, y2, gr, 0, Math.PI * 2);
          ctx!.fill();
        }
      }
    }

    let rafId = 0;
    function update() {
      rafId = requestAnimationFrame(update);

      let volume = 0;
      const data = activeRef.current ? getDataRef.current() : null;

      if (data) {
        // Берём ОБЩУЮ громкость (RMS) из временной области — никакого
        // разбора на частоты.
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        // Math.sqrt поверх линейного gain — гамма-коррекция: подтягивает
        // тихие сигналы (шёпот) заметно сильнее, чем сохраняет уже громкие,
        // не искажая крайние точки (0→0, 1→1). Без неё пришлось бы выбирать
        // между «шёпот незаметен» и «обычная речь мгновенно зашкаливает».
        volume = Math.min(1, Math.sqrt(rms * VOLUME_GAIN));

        // Каждая палочка живёт своей жизнью: своя фаза, своя скорость,
        // свой «вес». Всё умножается на общую громкость — тишина = ровное
        // кольцо, звук = живые бугры.
        const time = performance.now() * 0.001 * WAVE_SPEED;
        for (let i = 0; i < NUM_BARS; i++) {
          const t = time * BAR_SPEED[i] + BAR_PHASE[i];
          // Комбинируем несколько синусов — получается «органическая»
          // волна, а не идеальный синус, как у настоящего эквалайзера.
          const wave =
            Math.sin(t) * 0.45 +
            Math.sin(t * 2.13 + 1.7) * 0.3 +
            Math.sin(t * 4.71 - 0.9) * 0.15 +
            0.4;
          const mod = Math.max(0, Math.min(1, wave)) * BAR_BIAS[i];
          targets[i] = BASE_LENGTH + volume * mod * AUDIO_GAIN;
        }
      } else {
        for (let i = 0; i < NUM_BARS; i++) targets[i] = 0;
      }

      // Плавная интерполяция
      for (let i = 0; i < NUM_BARS; i++) {
        bars[i] += (targets[i] - bars[i]) * LERP;
      }

      draw();
    }
    update();

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resizeCanvas);
    };
    // Пустой список зависимостей — намеренно (см. коммент у activeRef
    // выше): цикл монтируется один раз и живёт, пока жив компонент.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={wrapRef} className="mic-ring-wrap">
      <canvas
        ref={canvasRef}
        className="mic-ring-canvas"
        style={{ opacity: active ? 1 : 0 }}
      />
      <div className="relative z-[2]">{children}</div>
    </div>
  );
}
