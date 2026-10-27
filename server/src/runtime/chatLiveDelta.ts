// Живой ход дельтами (владелец 27.10.2026, карточка 7b73b9c9 / Linear MAK-137,
// по образцу протокола AG-UI). Раньше chats:live раз в 150 мс нёс ход ЦЕЛИКОМ —
// весь текст заново. Здесь — разница между тем, что клиент уже получил, и
// новым видом хода: только добавки и изменённые поля.
//
// Разницу считаем по виду ДЛЯ КЛИЕНТА (после unwrapRoleEnvelope и
// stripQuickRepliesLine): он не всегда продолжает прежний, поэтому кроме
// text_append бывает text_replace.

export type LiveViewItem = { id: string; kind: string; text?: string; blocks?: unknown[]; [field: string]: unknown };
export type LiveView = { items: LiveViewItem[]; thinking: string | null };

export type LiveDeltaOp =
  | { op: "item_add"; item: LiveViewItem }
  | { op: "text_append"; item_id: string; text: string }
  | { op: "text_replace"; item_id: string; text: string }
  | { op: "item_update"; item_id: string; fields: Record<string, unknown> }
  | { op: "blocks"; item_id: string; blocks: unknown[] }
  | { op: "thinking"; phrase: string | null };

/** Поля шага, которые меняются по ходу. */
const UPDATABLE = ["tool", "detail", "status", "args", "output", "started_at", "ended_at"];

/** Состав блоков без растущей прозы в хвосте: её клиент дописывает сам из
 *  text_append, пересылать блоки ради неё — тот же полный текст заново. */
function blockShape(blocks: unknown[] | undefined): string {
  const list = blocks ?? [];
  return JSON.stringify(list.map((b, i) =>
    i === list.length - 1 && (b as { type?: string })?.type === "doc" ? { type: "doc" } : b));
}

export function liveDeltaOps(prev: LiveView | null, next: LiveView): LiveDeltaOp[] {
  const ops: LiveDeltaOp[] = [];
  const before = new Map((prev?.items ?? []).map((it) => [it.id, it]));
  for (const item of next.items) {
    const old = before.get(item.id);
    if (!old) { ops.push({ op: "item_add", item }); continue; }
    const was = old.text ?? "", now = item.text ?? "";
    if (now !== was) {
      ops.push(now.startsWith(was)
        ? { op: "text_append", item_id: item.id, text: now.slice(was.length) }
        : { op: "text_replace", item_id: item.id, text: now });
    }
    if (item.blocks && blockShape(item.blocks) !== blockShape(old.blocks)) {
      ops.push({ op: "blocks", item_id: item.id, blocks: item.blocks });
    }
    const fields: Record<string, unknown> = {};
    for (const key of UPDATABLE) if (item[key] !== old[key] && item[key] !== undefined) fields[key] = item[key];
    if (Object.keys(fields).length) ops.push({ op: "item_update", item_id: item.id, fields });
  }
  if ((prev?.thinking ?? null) !== next.thinking) ops.push({ op: "thinking", phrase: next.thinking });
  return ops;
}
