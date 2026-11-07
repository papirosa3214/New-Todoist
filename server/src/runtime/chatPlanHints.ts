// Подсказка «сдай пункт» посреди хода (владелец 06.11.2026): текст промежуточного
// сообщения роли сравнивается эмбеддингом (bge-m3-embed) с текущим и следующим
// пунктом плана. Совпало — steer той же доставкой, что memory/thrash-подсказки.
// Ничего не закрывается автоматически; модель недоступна — молча пропускаем
// (fail-open) с записью в журнал chat_plan_hints (kind=embed_unavailable).
// Журнал: таблица chat_plan_hints в основной БД — роль, пункт, косинус, сдан ли после.
import db from "../db.js";
import { getSetting } from "../lib/serverSettings.js";
import { getEmbeddings } from "../lib/embeddingClient.js";
import { chatPlanViewOf, readChatWorkPlan } from "../lib/subtaskWorkPlan.js";

export type Embedder = (texts: string[]) => Promise<number[][]>;
const defaultEmbedder: Embedder = async (texts) => {
  const r = await getEmbeddings(texts, { purpose: "plan_hint", timeoutMs: 5000 });
  return (Array.isArray(r.embeddings[0]) ? r.embeddings : [r.embeddings]) as number[][];
};
let embedder: Embedder = defaultEmbedder;
/** Подмена модели в тестах. */
export function setPlanHintEmbedder(fn: Embedder | null): void { embedder = fn ?? defaultEmbedder; }

const itemCache = new Map<string, number[]>();
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function journal(row: { chatId: string; roleId: string; itemId?: string | null; title?: string | null; kind: string; cosine?: number | null; threshold?: number | null; note?: string | null }) {
  try {
    db.prepare("INSERT INTO chat_plan_hints(chat_id,role_id,item_id,item_title,kind,cosine,threshold,hinted_at,note) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(row.chatId, row.roleId, row.itemId ?? null, row.title ?? null, row.kind, row.cosine ?? null, row.threshold ?? null, new Date().toISOString(), row.note ?? null);
  } catch { /* журнал — наблюдение, а не условие работы */ }
}

/** Состояние одного хода: не чаще одной подсказки на пункт. */
export class PlanHintGuard {
  private hinted = new Set<string>();
  private warnedUnavailable = false;
  constructor(private chatId: string, private roleId: string) {}

  /** Возвращает текст подсказки или null. Никогда не бросает. */
  async observe(text: string): Promise<string | null> {
    try {
      const clean = text.trim();
      if (clean.length < 20) return null;
      const plan = readChatWorkPlan(this.chatId, this.roleId);
      if (!plan) return null;
      const view = chatPlanViewOf(plan);
      if (view.status !== "active" || !view.current_item_id) return null;
      const idx = view.items.findIndex((i) => i.id === view.current_item_id);
      const current = view.items[idx];
      if (!current || (current.state !== "in_progress" && current.state !== "pending")) return null;
      const next = view.items.slice(idx + 1).find((i) => i.state === "pending");
      const wantCurrent = !this.hinted.has(current.id);
      const wantNext = !!next && !this.hinted.has("next:" + next.id);
      if (!wantCurrent && !wantNext) return null;
      const need: Array<{ key: string; title: string }> = [];
      const cached = (id: string, title: string) => {
        const key = `${plan.chat_id}|${plan.role_id}|${plan.revision}|${id}`;
        if (!itemCache.has(key)) need.push({ key, title });
        return key;
      };
      const curKey = cached(current.id, current.title);
      const nextKey = next ? cached(next.id, next.title) : null;
      const vectors = await embedder([clean, ...need.map((n) => n.title)]);
      need.forEach((n, i) => itemCache.set(n.key, vectors[i + 1]));
      if (itemCache.size > 2000) itemCache.clear();
      const vec = vectors[0];
      const thCur = Number(getSetting("chat_plan_hint_current_pct")) / 100;
      const thNext = Number(getSetting("chat_plan_hint_next_pct")) / 100;
      const cCur = cosine(vec, itemCache.get(curKey)!);
      if (wantCurrent && cCur >= thCur) {
        this.hinted.add(current.id);
        journal({ chatId: plan.chat_id, roleId: this.roleId, itemId: current.id, title: current.title, kind: "current", cosine: cCur, threshold: thCur });
        return `Похоже, пункт «${current.title}» выполнен — сдай его (taskflow_work_item_submit) с результатом`;
      }
      if (wantNext && nextKey) {
        const cNext = cosine(vec, itemCache.get(nextKey)!);
        if (cNext >= thNext) {
          this.hinted.add("next:" + next!.id);
          journal({ chatId: plan.chat_id, roleId: this.roleId, itemId: current.id, title: current.title, kind: "next", cosine: cNext, threshold: thNext, note: next!.title });
          return `Ты уже работаешь над «${next!.title}», а «${current.title}» не сдан — сдай его`;
        }
      }
      return null;
    } catch (error) {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        journal({ chatId: this.chatId, roleId: this.roleId, kind: "embed_unavailable", note: String((error as Error)?.message ?? error).slice(0, 300) });
      }
      return null;
    }
  }
}

/** Текст assistant-сообщения из события message_end; для сообщения с вызовом инструмента и без текста — пусто. */
export function assistantTextOf(event: any): string {
  const message = event?.message;
  if (event?.type !== "message_end" || message?.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join("\n");
}
