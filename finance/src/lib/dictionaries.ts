/**
 * Русские подписи типов счёта и источника операции — раздел 5.
 * На экранах нет английских enum-значений вроде `card` или `csv`.
 */

const ACCOUNT_TYPES: Record<string, string> = {
  cash: "Наличные",
  card: "Карта",
  deposit: "Вклад",
  investment: "Инвестиции",
  other: "Прочее",
};

const OPERATION_SOURCES: Record<string, string> = {
  manual: "ручной ввод",
  csv: "CSV",
  ofx: "OFX",
  import: "импорт",
};

export function accountTypeLabel(type: string): string {
  return ACCOUNT_TYPES[type] ?? type;
}

export function sourceLabel(source: string): string {
  return OPERATION_SOURCES[source] ?? source;
}