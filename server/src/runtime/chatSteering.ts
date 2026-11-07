import {chatIntentBlockForMessage} from "../lib/jevAssist.js";
import type { ChatExecutionMode } from "./chatExecutionMode.js";
/** Active chat input, separate from the FIFO of complete model runs.
 * Acceptance by the SDK is not delivery: acknowledge only after a user message
 * event and after the enclosing reply has been persisted. Unconsumed input
 * falls back to the durable FIFO (including the end-of-stream race).
 *
 * Реестр ведётся по роли, а не по паре (чат, роль): уточнение может прийти
 * из любого чата и от кого угодно (владелец 21.10.2026) — подмешивать надо
 * в тот ход, который у роли идёт сейчас. Если ходов несколько, берём тот,
 * что в том же чате; если такого нет и ход всего один — подмешиваем в него;
 * ходов несколько и ни одного в этом чате — не подмешиваем (неоднозначно),
 * сообщение уйдёт обычной очередью и ничего не потеряется.
 */
export interface SteeringReceipt {
  /** SDK принял ввод: событие пользовательского сообщения пришло. */
  delivered: Promise<boolean>;
  /** Ввод потреблён ходом (или ход закрылся, не взяв его). */
  consumed: Promise<boolean>;
  /** Ход завершён: ответ роли сохранён (true) или сорвался (false). */
  outcome: Promise<boolean>;
}
/** Что подмешивается в ход: от кого, откуда и что написано. */
export interface SteeringOffer {
  executionMode?: ChatExecutionMode;
  workMode?: string;
  /** Отправитель — имя или id. */
  from: string;
  /** Чат, где сообщение написано: оттуда оно и пришло в ход. */
  chatId: string;
  /** Название чата, где сообщение написано. */
  chatTitle: string;
  /** Текст сообщения. */
  body: string;
}
interface Pending {
  text: string;
  receipt: SteeringReceipt;
  resolve: (consumed: boolean) => void;
  resolveDelivered: (delivered: boolean) => void;
  seen: boolean;
  ready: Promise<boolean>;
}
interface Input {
  executionMode?: ChatExecutionMode;
  workMode?: string;
  chatId: string;
  roleId: string;
  steer: (text: string) => Promise<void>;
  outcome: Promise<boolean>;
}
interface Registration {
  chatId: string;
  hasInput: (id: string) => boolean;
  offer: (id: string, source: SteeringOffer) => Promise<SteeringReceipt | null>;
}
/** roleId → chatId → регистрация активного хода роли. */
const active = new Map<string, Map<string, Registration>>();

export function registerChatSteering(input: Input) {
  const entries = new Map<string, Pending>();
  let closed = false;
  let inputTail:Promise<unknown>=Promise.resolve();
  const registration: Registration = {
    chatId: input.chatId,
    hasInput: (id) => entries.has(id),
    async offer(id: string, source: SteeringOffer): Promise<SteeringReceipt | null> {
      if (closed) return null;
      if ((source.executionMode ?? "chat") !== (input.executionMode ?? "chat") || (source.workMode ?? "work") !== (input.workMode ?? "work")) return null;
      const previous = entries.get(id);
      if (previous) return await previous.ready ? previous.receipt : null;
      let resolve!: (ok: boolean) => void;
      let resolveDelivered!: (ok: boolean) => void;
      const consumed = new Promise<boolean>((r) => (resolve = r));
      const delivered = new Promise<boolean>((r) => (resolveDelivered = r));
      // Отметка источника — от кого, откуда и что делать. Из другого чата
      // автор ждёт ответа в своём чате: там его ждать неоткуда.
      const other = registration.chatId !== source.chatId;
      const tail = other
        ? `\nОтветь автору через taskflow_chat_reply(message_id=${id}, text=…) — в этом чате он твоего ответа не увидит.`
        : "";
      const entry: Pending = {
        text: `Сообщение в ход (сообщение ${id}):\nот ${source.from} из чата «${source.chatTitle}»:\n${source.body}${tail}`,
        receipt: { delivered, consumed, outcome: input.outcome },
        resolve,
        resolveDelivered,
        seen: false,
        ready: Promise.resolve(false),
      };
      entries.set(id, entry);
      // Install before invoking SDK: a synchronous message event must not be lost.
      entry.ready = inputTail.then(async () => {
        try {
          const guidance=await chatIntentBlockForMessage(id);
          if(closed){entry.resolveDelivered(false);entry.resolve(false);return false;}
          entry.text+=guidance;
          await input.steer(entry.text); return true;
        }
        catch { entries.delete(id); entry.resolveDelivered(false); entry.resolve(false); return false; }
      });
      inputTail=entry.ready;
      return await entry.ready ? entry.receipt : null;
    },
  };
  const byChat = active.get(input.roleId) ?? new Map<string, Registration>();
  byChat.set(input.chatId, registration);
  active.set(input.roleId, byChat);
  return {
    observe(event: any) {
      if (event?.type !== "message_start" || event.message?.role !== "user") return;
      const content = event.message.content;
      const text = typeof content === "string" ? content : (content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      for (const entry of entries.values()) if (entry.text === text && !entry.seen) {
        entry.seen = true;
        entry.resolveDelivered(true);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      const byChat = active.get(input.roleId);
      if (byChat?.get(input.chatId) === registration) {
        byChat.delete(input.chatId);
        if (!byChat.size) active.delete(input.roleId);
      }
      for (const entry of entries.values()) {
        entry.resolveDelivered(entry.seen);
        entry.resolve(entry.seen);
      }
    },
  };
}

export async function offerChatSteering(chatId: string, roleId: string, messageId: string, source: SteeringOffer): Promise<SteeringReceipt | null> {
  const byChat = active.get(roleId);
  if (!byChat) return null;
  const same = byChat.get(chatId);
  if (same) return await same.offer(messageId, source);
  // Ход в другом чате: подмешиваем, только если он один — иначе неясно, чей.
  if (byChat.size !== 1) return null;
  const only = [...byChat.values()][0];
  return await only.offer(messageId, source);
}

/** Для тестов: сбросить реестр активных ходов. */
export function _resetChatSteeringForTests(): void {
  active.clear();
}

/** Includes SDK acceptance in flight: it cannot safely be retracted. */
export function hasChatSteeringInput(messageId: string): boolean {
  return [...active.values()].some(byChat => [...byChat.values()].some(run => run.hasInput(messageId)));
}
