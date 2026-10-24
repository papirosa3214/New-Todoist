// Plural forms for "N задач" — 1 задача / 2-4 задачи / 5+ задач, with the
// usual 11-14 exception (11 задач, not 11 задача). Was duplicated
// verbatim in ProjectsScreen.tsx and LabelsScreen.tsx; consolidated here.
export function taskWord(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return "задач";
  const mod10 = n % 10;
  if (mod10 === 1) return "задача";
  if (mod10 >= 2 && mod10 <= 4) return "задачи";
  return "задач";
}
