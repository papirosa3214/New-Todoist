// Сторож повторяющихся рассуждений (владелец 02.11.2026): «если рассуждения
// повторяется, вообще выбрасывать, и говорить… подсказку давать, что план
// есть, действуй».
//
// Ловит не дословное совпадение (мысли растут от хода к ходу), а совпадение
// СМЫСЛА: если хвост рассуждения почти тот же, роль ходит по кругу.

/** Сколько символов хвоста сравниваем. */
const TAIL = 160;

/** Доля совпадения хвостов, при которой считаем повтором. */
const REPEAT_RATIO = 0.6;

function tail(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(-TAIL);
}

/** Похожи ли хвост текущего рассуждения на хвост предыдущего. */
export function isRepeatedThought(current: string, previous: string | null): boolean {
  if (!previous) return false;
  const a = tail(current);
  const b = tail(previous);
  if (a.length < 40 || b.length < 40) return false;
  const shorter = a.length <= b.length ? a : b;
  let common = 0;
  while (common < shorter.length && a[a.length - 1 - common] === b[b.length - 1 - common]) common++;
  return common / shorter.length >= REPEAT_RATIO;
}

/** Что сказать роли, когда она повторяет саму себя. */
export const THINKING_REPEAT_NUDGE =
  "Ты повторяешь одни и те же рассуждения — это съедает контекст и время, и работа стоит на месте. " +
  "Сформулируй вывод в двух-трёх предложениях и ДЕЙСТВУЙ: рабочий план уже есть, следующий шаг описан в нём. " +
  "Если шаг непонятен — спроси (`taskflow_consult`) или запиши вопрос в ленту карточки.";

/**
 * Сторож повторов рассуждений. Отдаёт указание, когда мысль повторилась
 * `repeatLimit` раз подряд.
 */
export class ThinkingGuard {
  private previous: string | null = null;
  private repeats = 0;

  constructor(private readonly repeatLimit: number = 2) {}

  observe(thought: string): string | null {
    const text = String(thought ?? "").trim();
    if (!text) return null;
    if (isRepeatedThought(text, this.previous)) {
      this.previous = text;
      this.repeats += 1;
      if (this.repeats < this.repeatLimit) return null;
      this.repeats = 0;
      return THINKING_REPEAT_NUDGE;
    }
    this.previous = text;
    this.repeats = 1;
    return null;
  }
}
