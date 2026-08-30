import { useRef, useState } from "react";
import Keyboard from "react-simple-keyboard";
import "react-simple-keyboard/build/css/index.css";
import { MicOverlay } from "../components/MicOverlay";
import { useMicRecorder } from "../lib/useMicRecorder";
import { useTranscribeAudio } from "../api/audio";

// ═══════════ ДЕМО: своя экранная клавиатура ═══════════
//
// Owner 2026-08-18: «давай в вебе быстренько клавиатуру и прифигачь туда
// нашу кнопку диктовки, хочу глянуть, что там и как» — это ПРОБНЫЙ экран
// на отдельном роуте (/kb-demo), намеренно НЕ подключённый ни к одному
// рабочему полю приложения. Общий TextField (components/UI.tsx) кормит все
// 19 полей ввода проекта — эксперимент через него протёк бы на каждый
// экран, поэтому здесь всё своё и одноразовое.
//
// Кнопка микрофона — КЛАВИШЕЙ ВНУТРИ клавиатуры, а не плавающей сверху
// (owner: «не надо, чтобы она висела, надо чтобы она была в клавиатуре,
// раз мы пишем её заново»). Существующий MicKeyboardBar не переиспользован
// сознательно: он позиционируется от `--kb-height` (высота СИСТЕМНОЙ
// клавиатуры из useVisualViewportInset) — при своей клавиатуре системной
// нет, переменная равна 0, и кнопка села бы вниз экрана под панель. Тот
// компонент остаётся нетронутым и по-прежнему верен для системной
// клавиатуры.
//
// Подавление системной клавиатуры (inputmode=none / readonly) здесь
// сознательно НЕ применяется: в десктопном браузере системной клавиатуры
// нет вовсе, гасить нечего. Разведка по подавлению на iOS лежит в базе
// знаний («Ресёрч и документация», 18.08.2026) — это отдельное решение.

// Раскладка снята с того же скриншота, что и метрики. Две вещи, которые на
// глаз не угадываются и в прошлом заходе были сделаны неверно:
//  1) в русской раскладке iOS в первом ряду ОДИННАДЦАТЬ клавиш, «ъ» в ней
//     нет вовсе (вводится долгим нажатием на «ь») — из-за лишней
//     двенадцатой клавиши весь ряд был уже системного;
//  2) подписи ЗАГЛАВНЫЕ независимо от регистра ввода — самое заметное
//     отличие от прошлого захода со строчными буквами. Регистр самих
//     вводимых символов задаётся в onKeyPress, не подписью.
const LAYOUTS = {
  default: [
    "й ц у к е н г ш щ з х",
    "ф ы в а п р о л д ж э",
    "{shift} я ч с м и т ь б ю {bksp}",
    "{numbers} {mic} {space} {enter}",
  ],
  shift: [
    "Й Ц У К Е Н Г Ш Щ З Х",
    "Ф Ы В А П Р О Л Д Ж Э",
    "{shift} Я Ч С М И Т Ь Б Ю {bksp}",
    "{numbers} {mic} {space} {enter}",
  ],
  numbers: [
    "1 2 3 4 5 6 7 8 9 0",
    '- / : ; ( ) ₽ & @ "',
    "{abc} . , ? ! ' + = {bksp}",
    "{abc} {mic} {space} {enter}",
  ],
};

// Системная клавиатура iOS рисует ВСЕ буквы заглавными, а вводит строчные,
// пока не нажат Shift. Поэтому раскладка держит строчные (они и попадают в
// поле), а сюда подставляются заглавные подписи — так подпись и введённый
// символ разведены, и незачем править регистр после каждого нажатия.
const CAPS_DISPLAY = Object.fromEntries(
  "йцукенгзхшщфывапролджэячсмитьбю"
    .split("")
    .map((ch) => [ch, ch.toUpperCase()]),
);

const DISPLAY = {
  ...CAPS_DISPLAY,
  // Подписи служебных клавиш с иконками — непечатаемый символ, а не текст:
  // сам рисунок даёт CSS-маска (класс kb-icon, см. index.css), а подпись
  // обязана быть непустой, иначе библиотека вернёт сырое «{bksp}» и т.п.
  "{bksp}": " ",
  "{enter}": " ",
  "{shift}": " ",
  // На системной клавиатуре пробел без надписи — только мелкая пометка
  // языка у правого края (её рисует CSS через ::after, см. index.css).
  // Именно неразрывный пробел, а не пустая строка: на пустую библиотека
  // подставляет обратно сырое имя кнопки и на клавише проступает «{space}».
  "{space}": " ",
  "{numbers}": "123",
  "{abc}": "АБВ",
  "{mic}": " ",
};


export function KeyboardDemoScreen() {
  const [text, setText] = useState("");
  const [layoutName, setLayoutName] = useState<keyof typeof LAYOUTS>("default");
  const [micNote, setMicNote] = useState<string | null>(null);
  const keyboardRef = useRef<any>(null);

  const transcribeAudio = useTranscribeAudio();

  const mic = useMicRecorder(async (blob) => {
    try {
      const res = await transcribeAudio.mutateAsync(blob);
      const clean = res.text.trim();
      if (clean) {
        // Дописываем в конец, а не в позицию каретки: работа
        // simple-keyboard с непустым выделением и вставкой в середину
        // строки по итогам разведки осталась НЕ подтверждённой — для
        // пробного экрана на это не опираемся.
        setText((prev) => {
          const next = prev ? `${prev} ${clean}` : clean;
          keyboardRef.current?.setInput(next);
          return next;
        });
      }
      setMicNote(
        res.source === "whisper"
          ? "Whisper на устройстве"
          : res.source === "apple"
            ? "диктовка Apple (модель не скачана)"
            : "распознано на сервере",
      );
    } catch {
      setMicNote("не удалось распознать");
    } finally {
      mic.finish();
    }
  });

  const micElapsedLabel = (() => {
    const totalSec = Math.floor(mic.elapsedMs / 1000);
    const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
    const s = String(totalSec % 60).padStart(2, "0");
    return `${m}:${s}`;
  })();

  function onKeyPress(button: string) {
    if (button === "{shift}") {
      setLayoutName((n) => (n === "shift" ? "default" : "shift"));
      return;
    }
    if (button === "{numbers}") {
      setLayoutName("numbers");
      return;
    }
    if (button === "{abc}") {
      setLayoutName("default");
      return;
    }
    if (button === "{mic}") {
      if (mic.state === "idle") mic.start();
      return;
    }
    // После одиночной заглавной возвращаемся в нижний регистр — как ведёт
    // себя системная клавиатура. simple-keyboard сам этого не делает:
    // Shift и CapsLock в его демо намеренно совпадают.
    if (layoutName === "shift") setLayoutName("default");
  }

  const micError =
    mic.error ?? (transcribeAudio.isError ? transcribeAudio.error : null);

  return (
    <div className="min-h-dvh bg-bg text-text flex flex-col">
      <div className="flex-1 px-4 pt-6">
        <h1 className="text-[20px] font-semibold mb-1">Своя клавиатура</h1>
        <p className="text-[13px] text-sub mb-4">
          Пробный экран. Тапни по полю и набирай — системная клавиатура здесь не
          участвует.
        </p>

        <div className="bg-card rounded-2xl px-4 py-3 mb-3">
          <input
            // Системная клавиатура гасится этим атрибутом. Замер на iPhone Air
            // (iOS 26.6) 18.08.2026: инсет visualViewport 0px против 413px у
            // поля без атрибута. Каретка при этом остаётся — поэтому НЕ
            // readonly, с ним WebKit каретку не рисует.
            inputMode="none"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              keyboardRef.current?.setInput(e.target.value);
            }}
            placeholder="Название задачи"
            className="w-full bg-transparent text-[16px] text-text placeholder:text-dim outline-none"
          />
        </div>

        {micNote && <p className="text-[12px] text-dim mb-2">{micNote}</p>}
        {micError != null && (
          <p className="text-[12px] text-coral mb-2">
            {typeof micError === "string" ? micError : "Ошибка микрофона"}
          </p>
        )}
        <p className="text-[12px] text-dim">Символов: {text.length}</p>
      </div>

      {/* Отступы и фон панели — в CSS (.kb-demo), не Tailwind-классами:
          там же лежат все числа клавиатуры, держать их в одном месте. */}
      <div className="kb-demo">
        <Keyboard
          keyboardRef={(r) => (keyboardRef.current = r)}
          layout={LAYOUTS}
          layoutName={layoutName}
          display={DISPLAY}
          onChange={setText}
          onKeyPress={onKeyPress}
          // Кнопки настоящими <button>, а не <div> — первый совет
          // мейнтейнера по iOS-issue #2739 (тап иногда попадал в соседнюю
          // клавишу). Тут же даёт бесплатную доступность с клавиатуры.
          useButtonTag
          buttonTheme={[
            {
              class: "kb-key-util",
              buttons: "{numbers} {abc}",
            },
            // Клавиши с иконками: подпись прячется, рисунок даёт CSS-маска.
            {
              class: "kb-icon",
              buttons: "{shift} {bksp} {enter} {mic}",
            },
          ]}
        />
      </div>

      {(mic.state === "recording" || mic.state === "processing") && (
        <MicOverlay
          state={mic.state}
          elapsedLabel={micElapsedLabel}
          getTimeDomainData={mic.getTimeDomainData}
          onStop={mic.stop}
        />
      )}
    </div>
  );
}
