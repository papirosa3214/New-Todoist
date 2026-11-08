// Память ролей в Mnemosyne (владелец 08.11.2026: «надо, чтобы всё
// записывалось в этой Mnemosyne и пользовались им, а не своими файлами
// с папками»).
//
// Как устроено. В Mnemosyne «банк» — отдельное хранилище, записи одного
// банка не видны из другого. Этим и держится приватность ролей, которой
// раньше служил scope в таблице memories:
//   tf-team            — память команды (видят все роли)
//   tf-role-<role_key> — своя память роли (чужие роли её не видят)
//   tf-project-<id>    — память проекта
// Роль ищет в трёх банках сразу и получает объединённый список.
//
// Длина. Mnemosyne отдаёт из поиска не больше ~400 знаков на запись и
// полное тело по `get` для свежей записи не находит, поэтому длинный урок
// режется на части до записи: каждая часть — самостоятельная запись банка,
// склеить их обратно можно по `title` и `chunk_no` в metadata.
import { mnemoForget, mnemoRecall, mnemoRemember, type MnemosyneHit } from "./mnemosyneClient.js";

/** Предел одной записи в банке (Mnemosyne обрезает вывод около 400 знаков). */
export const MAX_RECORD_CHARS = 350;

export const TEAM_BANK = "tf-team";

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function roleBank(roleKey: string): string {
  return `tf-role-${slug(roleKey)}`;
}

export function projectBank(projectId: string): string {
  return `tf-project-${slug(projectId)}`;
}

export type MemoryScopeName = "team" | "role" | "project";

/** Банк, в который идёт запись данной области. */
export function bankForScope(
  scope: MemoryScopeName,
  roleKey?: string | null,
  projectId?: string | null,
): string {
  if (scope === "role" && roleKey) return roleBank(roleKey);
  // Проектных банок нет: проектная запись видна команде (владелец 08.11.2026).
  if (scope === "project") return TEAM_BANK;
  return TEAM_BANK;
}

/** Где роль имеет право искать: командная банка + своя ролевая. */
export function banksFor(input: { roleKey?: string | null }): string[] {
  const banks = [TEAM_BANK];
  if (input.roleKey) banks.push(roleBank(input.roleKey));
  return [...new Set(banks)];
}

/** Область по имени банка — для подписи найденной записи. */
export function scopeOfBank(bank: string): MemoryScopeName {
  if (bank.startsWith("tf-role-")) return "role";
  if (bank.startsWith("tf-project-")) return "project";
  return "team";
}

/** Режем текст на части по границам предложений, не длиннее `limit`. */
export function splitRecord(text: string, limit = MAX_RECORD_CHARS): string[] {
  const body = text.replace(/\r\n/g, "\n").trim();
  if (!body) return [];
  if (body.length <= limit) return [body];
  const sentences = body.match(/[^.!?\n]+[.!?]?\s*|\n+/g) ?? [body];
  const parts: string[] = [];
  let current = "";
  const push = () => {
    const trimmed = current.trim();
    if (trimmed) parts.push(trimmed);
    current = "";
  };
  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) continue;
    if (piece.length > limit) {
      push();
      for (let i = 0; i < piece.length; i += limit) parts.push(piece.slice(i, i + limit).trim());
      continue;
    }
    if (current && current.length + piece.length + 1 > limit) push();
    current = current ? `${current} ${piece}` : piece;
  }
  push();
  return parts.filter(Boolean);
}

export interface MemoryRecordInput {
  text: string;
  title?: string | null;
  scope: MemoryScopeName;
  roleKey?: string | null;
  projectId?: string | null;
  kind: string;
  importance?: number;
  /** id записи в локальной таблице — чтобы связать части между собой. */
  memoryId?: string;
}

export interface MemoryRecordWritten {
  bank: string;
  ids: string[];
}

/** Записать урок в банк Mnemosyne (частями, если длинный). */
export async function writeRecord(input: MemoryRecordInput): Promise<MemoryRecordWritten> {
  const bank = bankForScope(input.scope, input.roleKey, input.projectId);
  const parts = splitRecord(input.text);
  if (!parts.length) return { bank, ids: [] };
  const ids: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const heading =
      i === 0 && input.title ? `${input.title}\n` : parts.length > 1 ? `(${i + 1}/${parts.length}) ` : "";
    const stored = await mnemoRemember({
      content: `${heading}${parts[i]}`,
      importance: input.importance ?? 0.6,
      source: input.kind === "lesson" ? "insight" : input.kind === "preference" ? "preference" : "fact",
      veracity: "stated",
      bank,
      metadata: {
        memory_id: input.memoryId ?? "",
        scope: input.scope,
        role_key: input.roleKey ?? "",
        project_id: input.projectId ?? "",
        kind: input.kind,
        chunk_no: i,
        chunks: parts.length,
        title: input.title ?? "",
      },
    });
    const id = stored.memory_id ?? stored.id ?? "";
    if (!id) throw new Error("Mnemosyne не вернула id записи");
    ids.push(id);
  }
  return { bank, ids };
}

/** Удалить части урока из банка (при правке/удалении записи). */
export async function forgetIds(bank: string, ids: string[]): Promise<number> {
  let removed = 0;
  for (const id of ids) {
    try {
      await mnemoForget(id, bank);
      removed += 1;
    } catch {
      // Черновик уже сжался в другую запись — это не ошибка: считаем, что
      // забыли. Молчаливой потери здесь нет: тело всё равно перезаписано.
    }
  }
  return removed;
}

export interface BankHit extends MnemosyneHit {
  bank: string;
  scope: MemoryScopeName;
}

/**
 * Поиск сразу в нескольких банках. Каждый банк опрашивается отдельно
 * (`bank` — параметр Mnemosyne), результаты сливаются и чистятся от
 * повторов: части одного урока не должны занимать весь бюджет выдачи.
 */
export async function recallAcrossBanks(input: {
  banks: string[];
  query: string;
  limit: number;
}): Promise<BankHit[]> {
  const perBank = Math.max(input.limit, 4);
  const settled = await Promise.all(
    input.banks.map(async (bank) => {
      try {
        const hits = await mnemoRecall(input.query, perBank, bank);
        return hits.map((hit) => ({ ...hit, bank, scope: scopeOfBank(bank) }));
      } catch (err) {
        // Первый банк — команда. Если он недоступен, это поломка памяти, а
        // не «ничего не нашлось»: пусть вызов падает с причиной.
        if (bank === TEAM_BANK) throw err;
        return [] as BankHit[];
      }
    }),
  );
  const seen = new Set<string>();
  const merged: BankHit[] = [];
  for (const hit of settled.flat().sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    const key = hit.content.slice(0, 120).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
    if (merged.length >= input.limit * 2) break;
  }
  return merged;
}
