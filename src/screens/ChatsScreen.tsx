// Список моих чатов с ролями-агентами. Точка входа — пункт «Чаты» на
// OverviewScreen (см. там), отдельного места в нижней панели чат пока
// не получил (решение 21.09.2026: владелец смотрит на «Дневник» слева
// от «Чата», менять раскладку табов не нужно).
//
// Карточка чата — те же приёмы, что в списках лейблов/проектов: один
// блок bg-card rounded-2xl, аватары участников слева внахлёст
// (как в существующем AgentsScreen, чтобы не придумывать новый
// визуальный язык), заголовок и подпись «последнее сообщение»
// справа. Превью обрезано по длине — карточки в списке должны
// быть одной высоты, без визуальной лесенки.
//
// Состояние пустого списка — отдельный экран с подсказкой и кнопкой
// «Создать чат», не «голое» сообщение: пользователь только что пришёл
// сюда в первый раз, без конкретного приглашения к действию экран
// выглядит тупиком.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useChats } from "../api/chats";
import { useCurrentUser } from "../api/auth";
import {
  Avatar,
  ErrorBanner,
  Icon,
  Loading,
  ScreenHeader,
} from "../components/UI";
import { formatRelativeTime } from "../lib/date";
import { CreateChatSheet } from "./CreateChatSheet";
import type { ApiChat, ApiChatMember } from "../api/types";

export function ChatsScreen() {
  const navigate = useNavigate();
  const { data: me } = useCurrentUser();
  const { data: chats = [], isLoading, isError, error } = useChats();
  const [createOpen, setCreateOpen] = useState(false);

  const openCreate = () => setCreateOpen(true);
  const closeCreate = () => setCreateOpen(false);

  return (
    <div className="px-4 pb-4">
      <ScreenHeader
        title="Чаты"
        actions={
          <button
            onClick={openCreate}
            aria-label="Новый чат"
            className="w-[44px] h-[44px] -mr-2.5 flex items-center justify-center tap-row"
          >
            <Icon name="plus" size={20} />
          </button>
        }
      />

      {isLoading && <Loading variant="block" />}
      <ErrorBanner
        error={isError ? error : null}
        fallback="Не удалось загрузить список чатов."
      />

      {!isLoading && chats.length === 0 && !isError && (
        <EmptyState onCreate={openCreate} />
      )}

      {!isLoading && chats.length > 0 && (
        <ul className="flex flex-col gap-2">
          {chats.map((c) => (
            <li key={c.id}>
              <ChatRow
                chat={c}
                meId={me?.id}
                onClick={() => navigate(`/chats/${c.id}`)}
              />
            </li>
          ))}
        </ul>
      )}

      {/* Шит создания чата. Лежит здесь же, чтобы не плодить
          отдельный экран под форму: всё, что он делает — выбор ролей
          и (опционально) название, на месте же возвращает id нового
          чата и навигирует в него (см. CreateChatSheet.submit). */}
      <CreateChatSheet open={createOpen} onClose={closeCreate} />
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-16">
      <div className="w-16 h-16 rounded-full bg-card flex items-center justify-center mb-4">
        <Icon name="chat" size={28} className="text-sub" />
      </div>
      <h2 className="text-[19px] font-semibold text-text mb-1">
        Чатов пока нет
      </h2>
      <p className="text-[14px] text-sub leading-relaxed max-w-[280px] mb-6">
        Создайте персональный чат с одной ролью или групповой — с
        несколькими сразу.
      </p>
      <button
        onClick={onCreate}
        className="h-12 px-6 rounded-xl bg-red text-[15px] font-semibold text-white tap-fade"
      >
        Новый чат
      </button>
    </div>
  );
}

function ChatRow({
  chat,
  meId,
  onClick,
}: {
  chat: ApiChat;
  meId?: string;
  onClick: () => void;
}) {
  // Участники без владельца — «собеседники» в карточке. Сервер
  // включает создателя в members автоматически (server/src/routes/
  // chats.ts:POST /api/chats), так что фильтруем здесь.
  const others = chat.members.filter((m) => m.id !== meId);
  // На групповом чате аватары заходят внахлёст, как в AgentsScreen:
  // первый — со сдвигом 0, остальные — на половинку диаметра.
  const visible = others.slice(0, 3);
  const overflow = others.length - visible.length;

  // Подпись «последнее сообщение»: либо превью (если есть), либо
  // пустая лента «Нет сообщений». Превью обрезаем — карточки одной
  // высоты.
  const last = chat.last_message;
  const lastText = last ? truncate(last.text, 80) : "Нет сообщений";
  const lastAuthor = last
    ? findMemberName(chat.members, last.from_user_id)
    : null;
  const lastLine = lastAuthor ? `${lastAuthor}: ${lastText}` : lastText;
  const lastTime = last ? formatRelativeTime(last.created_at) : "";

  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-card rounded-2xl p-3 flex items-center gap-3 tap-row"
    >
      <AvatarStack members={visible} overflow={overflow} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[15px] font-semibold text-text min-w-0 truncate">
            {chat.title || defaultTitle(others)}
          </h3>
          {lastTime && (
            <span className="text-[12px] text-dim shrink-0 tabular-nums">
              {lastTime}
            </span>
          )}
        </div>
        <p className="text-[13px] text-sub min-w-0 truncate">{lastLine}</p>
      </div>
      <Icon name="chevron" size={16} className="text-dim shrink-0" />
    </button>
  );
}

function AvatarStack({
  members,
  overflow,
}: {
  members: ApiChatMember[];
  overflow: number;
}) {
  // Ширина стека: первый аватар 32px, каждый следующий поверх
  // половины (mx--8), плюс крошка «+N» справа, если вообще есть
  // кого показывать сверх лимита.
  const SIZE = 32;
  const HALF = SIZE / 2;
  return (
    <div className="flex items-center shrink-0" style={{ width: stackWidth(members.length, overflow, SIZE, HALF) }}>
      {members.map((m, i) => (
        <div
          key={m.id}
          style={{
            marginLeft: i === 0 ? 0 : -HALF,
            zIndex: members.length - i,
          }}
        >
          <Avatar
            initials={m.initials || m.name?.[0] || "?"}
            color={m.avatar_color || "#A6A6A6"}
            avatar_url={m.avatar_url}
            size={SIZE}
          />
        </div>
      ))}
      {overflow > 0 && (
        <div
          className="rounded-full bg-card2 border-2 border-card flex items-center justify-center text-[11px] text-sub font-semibold tabular-nums"
          style={{
            width: SIZE,
            height: SIZE,
            marginLeft: -HALF,
          }}
        >
          +{overflow}
        </div>
      )}
    </div>
  );
}

/** Ширина стека аватаров — нужна, чтобы блок не схлопывался по
 *  контенту (аватары внахлёст могут «съесть» ширину до нуля, и блок
 *  сожмётся до половинки диаметра первого). */
function stackWidth(
  count: number,
  overflow: number,
  size: number,
  half: number,
): number {
  if (count === 0 && overflow === 0) return size;
  const visibleCount = count > 0 ? count : 0;
  const overflowCount = overflow > 0 ? 1 : 0;
  const items = visibleCount + overflowCount;
  return size + (items - 1) * (size - half);
}

/** Имя по id среди участников чата. На случай, если from_user_id
 *  сообщения совпадает с одним из members (в т.ч. с владельцем —
 *  тогда подпись будет «Максим: …», что и нужно). */
function findMemberName(members: ApiChatMember[], id: string): string | null {
  const m = members.find((x) => x.id === id);
  return m?.name ?? null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Заголовок по умолчанию — для group-чатов без title (сервер оставляет
 *  поле пустым, если клиент не передал). В direct-чате title тоже не
 *  обязателен, но там имя единственного собеседника читается в шапке
 *  комнаты, а здесь — в этой карточке. */
function defaultTitle(others: ApiChatMember[]): string {
  if (others.length === 1) return others[0].name;
  if (others.length === 0) return "Чат";
  return `Чат с ${others.length} ролями`;
}
