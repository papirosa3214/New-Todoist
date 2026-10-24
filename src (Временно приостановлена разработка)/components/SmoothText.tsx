import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Плавный вывод текста сообщения — по строке, с мягким проявлением.
 *
 * Владелец 17.10.2026 попросил: «текст появляется плавно, не сразу, как будто
 * построчно печатается». Задержка живёт ТОЛЬКО здесь, в отображении уже
 * полученного текста: сервер отдаёт сообщение целиком, файлы и виджеты
 * появляются сразу и анимации не ждут — иначе задержка задела бы создание
 * артефактов и прочие операции.
 *
 * Длинные сообщения идут быстрее коротких, иначе чтение растянется на
 * минуты: шаг сокращается с ростом числа строк.
 */
export function SmoothText({ text, className }: { text: string; className?: string }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const [shown, setShown] = useState(lines.length);
  const firstRun = useRef(true);

  useEffect(() => {
    // Старые сообщения при монтировании ленты показываем целиком:
    // перелистывать историю с задержкой незачем.
    if (firstRun.current) {
      firstRun.current = false;
      setShown(lines.length);
      return;
    }
    if (lines.length === 0) return;
    setShown(0);
    let index = 0;
    // Много строк — идём быстрее, иначе длинный ответ печатается полминуты.
    const step = lines.length > 12 ? 55 : lines.length > 5 ? 90 : 130;
    let timer = 0;
    const tick = () => {
      index += 1;
      setShown(index);
      if (index < lines.length) timer = window.setTimeout(tick, step);
    };
    timer = window.setTimeout(tick, 40);
    return () => window.clearTimeout(timer);
  }, [text, lines.length]);

  if (shown >= lines.length) {
    return <span className={className}>{text}</span>;
  }
  return (
    <span className={className}>
      {lines.slice(0, shown).join("\n")}
    </span>
  );
}