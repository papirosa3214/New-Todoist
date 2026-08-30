import { useRef, useState } from "react";

import {
  useAgents,
  useCreateAgent,
  useRenameAgent,
  useDeleteAgent,
} from "../api/agents";
import { useCurrentUser } from "../api/auth";
import { useUploadAvatar, useDeleteAvatar } from "../api/avatars";
import {
  Icon,
  Avatar,
  ScreenHeader,
  ErrorBanner,
  Loading,
} from "../components/UI";
import { useDialog } from "../components/Dialog";
import { useRowSwipe, ROW_ACTION_W } from "../lib/useRowSwipe";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import { getErrorMessage } from "../lib/errors";
import { roleLabel } from "../lib/taskOwner";
import type { ApiUser } from "../api/types";

// Живая аватарка (27.08.2026, просьба владельца): агент с записанными
// avatar_url_working/avatar_url_blocked ведёт себя по activity, которую
// вычисляет сервер (GET /api/agents) — blocked приоритетнее working,
// простой — дефолтная avatar_url. Агент без вариантов (у большинства их
// нет) просто всегда показывает дефолт, ничего не падает.
function resolveAvatarUrl(agent: ApiUser): string | null | undefined {
  if (agent.activity === "blocked" && agent.avatar_url_blocked) {
    return agent.avatar_url_blocked;
  }
  if (agent.activity === "working" && agent.avatar_url_working) {
    return agent.avatar_url_working;
  }
  return agent.avatar_url;
}

// Строка списка — только показ, без кликов. Смена/удаление фото переехали
// в форму редактирования (AgentAvatarEditor ниже) 27.08.2026, тем же
// поводом что и свайп вместо иконок: крестик на каждой аватарке в списке
// ловил случайные тапы («висят везде крестики, что я случайно нажал и
// удалил» — владелец). Теперь тронуть аватарку можно только войдя в
// редактирование строки.
function AgentAvatar({ agent }: { agent: ApiUser }) {
  return (
    <Avatar
      initials={agent.initials}
      color={agent.avatar_color}
      avatar_url={resolveAvatarUrl(agent)}
      size={36}
    />
  );
}

// Смена/удаление аватарки — только внутри формы редактирования строки, тот
// же визуальный приём, что AccountAvatarRow в SettingsScreen (крупная
// аватарка + «Убрать фото» рядом), но без своего клика по строке — здесь
// она уже внутри открытой формы, второй уровень вложенности не нужен.
// Загрузка/удаление правят дефолтный вариант (простой) — working/blocked
// не выведены в интерфейс, только через API.
function AgentAvatarEditor({ agent }: { agent: ApiUser }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = useUploadAvatar(agent.id);
  const del = useDeleteAvatar(agent.id);
  const [error, setError] = useState<string | null>(null);
  const busy = upload.isPending || del.isPending;

  return (
    <div className="flex items-center gap-3 mb-3">
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        aria-label={`Сменить аватарку «${agent.name}»`}
        className="relative shrink-0 tap-scale"
      >
        <Avatar
          initials={agent.initials}
          color={agent.avatar_color}
          avatar_url={resolveAvatarUrl(agent)}
          size={48}
        />
        <span className="absolute inset-0 rounded-full bg-black/0 hover:bg-black/30 transition-colors flex items-center justify-center">
          <Icon
            name="image"
            size={14}
            className="text-white opacity-0 hover:opacity-100"
          />
        </span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setError(null);
          upload.mutate(file, {
            onError: (err) => setError(getErrorMessage(err)),
          });
        }}
      />
      <div className="flex flex-col items-start gap-1">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="tap-fade py-1 px-2.5 rounded-lg bg-card2 border border-stroke text-[12px] text-text font-medium"
        >
          Заменить фото
        </button>
        {agent.avatar_url && (
          <button
            type="button"
            onClick={() => del.mutate()}
            disabled={busy}
            aria-label={`Убрать аватарку «${agent.name}»`}
            className="tap-fade text-[12px] text-sub"
          >
            Убрать фото
          </button>
        )}
        {error && <div className="text-[11px] text-coral">{error}</div>}
      </div>
    </div>
  );
}

// Одна строка = один экземпляр компонента со своим состоянием редактирования
// имени — тот же паттерн, что LabelRow в LabelsScreen: правка одной строки
// не может зацепить соседнюю. Свайп вместо иконок «изменить/удалить» — та
// же схема и по тому же поводу, что ProjectRow в ProjectsScreen (27.08.2026,
// владелец: «убрать иконки, применить точно такую же схему по свайпам»).
function AgentRow({
  agent,
  editable,
  onRequestDelete,
}: {
  agent: ApiUser;
  editable: boolean;
  onRequestDelete: (agent: ApiUser) => void;
}) {
  const renameAgent = useRenameAgent();
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(agent.name);
  // Слева «Удалить», справа «Изменить» — как в строке задачи/проекта.
  // Для нечитаемых (неагентских/чужих) строк действий нет — hasLeft/
  // hasRight оба false, палец просто не сдвинет строку.
  const swipe = useRowSwipe(editable, editable);

  const startEdit = () => {
    setName(agent.name);
    renameAgent.reset();
    setEditingName(true);
  };

  const handleSave = useGuardedCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === agent.name) {
      setEditingName(false);
      return;
    }
    await renameAgent.mutateAsync({ id: agent.id, name: trimmed });
    setEditingName(false);
  });

  if (editingName) {
    return (
      <div className="p-4">
        <AgentAvatarEditor agent={agent} />
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Имя агента"
          className="w-full bg-card2 rounded-xl px-3 py-2.5 text-[16px] text-text placeholder:text-dim outline-none mb-3"
        />
        <ErrorBanner
          error={renameAgent.error}
          fallback="Не удалось переименовать агента"
          variant="block"
          className="mb-3"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setEditingName(false)}
            className="flex-1 h-11 rounded-xl bg-card2 text-[14px] text-sub font-semibold tap-row"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!name.trim() || renameAgent.isPending}
            className="flex-1 h-11 rounded-xl bg-red text-[14px] text-white font-semibold disabled:opacity-50 tap-fade"
          >
            {renameAgent.isPending ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div data-hswipe className="relative overflow-hidden" onPointerDown={swipe.onPointerDown}>
      {/* Удалить — слева, открывается свайпом вправо */}
      <button
        onClick={() => {
          swipe.close();
          onRequestDelete(agent);
        }}
        aria-label={`Удалить «${agent.name}»`}
        className="absolute inset-y-0 left-0 flex flex-col items-center justify-center gap-0.5 text-white"
        style={{ width: ROW_ACTION_W, background: "#FF3B30" }}
      >
        <Icon name="trash" size={18} />
        <span className="text-[11px] font-medium">Удалить</span>
      </button>
      {/* Изменить — справа, открывается свайпом влево */}
      <button
        onClick={() => {
          swipe.close();
          startEdit();
        }}
        aria-label={`Переименовать «${agent.name}»`}
        className="absolute inset-y-0 right-0 flex flex-col items-center justify-center gap-0.5 text-white"
        style={{ width: ROW_ACTION_W, background: "#007AFF" }}
      >
        <Icon name="edit" size={18} />
        <span className="text-[11px] font-medium">Изменить</span>
      </button>

      <div
        className="flex items-center gap-3 py-3 px-4 bg-card"
        style={{
          transform: `translateX(${swipe.x}px)`,
          transition: swipe.animate
            ? "transform 0.25s cubic-bezier(0.32,0.72,0,1)"
            : "none",
        }}
      >
        <AgentAvatar agent={agent} />
        <div className="flex-1 min-w-0">
          <div className="text-[15px] text-text truncate">{agent.name}</div>
          {/* Чем агент занят прямо сейчас (29.08.2026, 31f2759e).
              Показываем только если онлайн: иначе «работает» означало бы
              последнее действие, которое могло быть вчера. last_action +
              last_action_title идут вместе: «читает задачу "Время в
              трекере отстаёт на три часа"». */}
          {agent.online && agent.last_action ? (
            <div className="text-[12px] text-sub truncate mt-0.5">
              {agent.last_action}
              {agent.last_action_title ? ` «${agent.last_action_title}»` : ""}
            </div>
          ) : null}
        </div>
        <span
          className="text-[12px] font-medium px-2 py-0.5 rounded text-white shrink-0"
          style={{
            backgroundColor:
              agent.role === "owner"
                ? "#E44332"
                : agent.role === "orchestrator"
                  ? "#4A9FD8"
                  : agent.type === "ai"
                    ? "#A78BFA"
                    : "#FF9A14",
          }}
        >
          {roleLabel(agent.role)}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Живой индикатор «онлайн» теперь опирается на agent.online —
              вычисляется сервером из lastSeenAt (29.08.2026, 31f2759e),
              а не на agent.status, который у агента без сокета всегда
              'offline' и соврёт. */}
          <div
            className={`w-[7px] h-[7px] rounded-full ${agent.online ? "bg-green" : "bg-dim"}`}
          />
          <span className="text-[12px] text-sub">
            {agent.online ? "Онлайн" : "Офлайн"}
          </span>
          {/* Limits display */}
          {agent.limits ? (
            <span className="ml-2 text-[11px] text-sub">
              Остаток: {agent.limits.remaining ?? "неизвестно"}
            </span>
          ) : (
            <span className="ml-2 text-[11px] text-sub">без лимита</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function AgentsScreen() {
  const { data: agents = [], isLoading, error, isError } = useAgents();
  const { data: me } = useCurrentUser();
  const createAgent = useCreateAgent();
  const deleteAgent = useDeleteAgent();
  const { confirm, dialog } = useDialog();
  const [showInvite, setShowInvite] = useState(false);
  const [name, setName] = useState("");
  const [deleteError, setDeleteError] = useState<unknown>(null);
  // Ключ живёт только здесь, в состоянии экрана: сервер отдаёт его ровно
  // один раз при создании и больше ни одним маршрутом не показывает.
  const [issuedToken, setIssuedToken] = useState<{
    name: string;
    token: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const isOwner = me?.role === "owner";

  const handleDeleteAgent = async (agent: ApiUser) => {
    const ok = await confirm({
      title: `Удалить агента «${agent.name}»?`,
      description:
        "Учётка и ключ доступа удалятся. Если за агентом остались задачи, шаги или комментарии — сервер откажет, их сначала нужно переназначить. Действие нельзя отменить.",
      confirmLabel: "Удалить",
      danger: true,
    });
    if (!ok) return;
    setDeleteError(null);
    try {
      await deleteAgent.mutateAsync(agent.id);
    } catch (err) {
      setDeleteError(err);
    }
  };

  return (
    <div className="px-4 pb-4">
      {dialog}
      <ScreenHeader variant="compact" title="Команда" />

      <ErrorBanner
        error={isError ? error : null}
        fallback="Не удалось загрузить список агентов"
        variant="inline"
        className="mt-3"
      />

      {/* Team */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2 mt-2">
        Команда
      </div>
      {isLoading && <Loading className="mb-4" />}
      <ErrorBanner
        error={deleteError}
        fallback="Не удалось удалить агента"
        variant="block"
        className="mb-2"
      />
      <div className="bg-card rounded-2xl overflow-hidden mb-4">
        {agents.map((u) => (
          <AgentRow
            key={u.id}
            agent={u}
            editable={isOwner && u.type === "ai"}
            onRequestDelete={handleDeleteAgent}
          />
        ))}
        {!isLoading && agents.length === 0 && (
          <div className="px-4 py-3 text-[13px] text-dim">
            Нет пользователей
          </div>
        )}
      </div>

      {/* Новый агент — учётка + ключ доступа. Почты на машине нет, и
          «пригласить» здесь значит именно завести агента: сервер создаёт
          учётку и один раз показывает ключ (POST /api/agents). */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">
        Новый агент
      </div>
      <div className="bg-card rounded-2xl overflow-hidden mb-4">
        {issuedToken ? (
          <div className="p-4">
            <p className="text-[13px] text-text mb-1">
              Агент «{issuedToken.name}» заведён
            </p>
            <p className="text-[12px] text-sub mb-3">
              Ключ показывается один раз — сохраните его сейчас. Потом он нигде
              не отображается, можно только выпустить новый.
            </p>
            <div className="bg-card2 rounded-xl px-3 py-2.5 mb-3">
              <code className="text-[12px] text-text break-all">
                {issuedToken.token}
              </code>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(issuedToken.token);
                  setCopied(true);
                }}
                className="tap-scale h-11 px-4 rounded-xl bg-red text-white text-[14px] font-semibold"
              >
                {copied ? "Скопировано" : "Скопировать ключ"}
              </button>
              <button
                onClick={() => {
                  setIssuedToken(null);
                  setCopied(false);
                }}
                className="tap-scale h-11 px-4 rounded-xl bg-card2 text-sub text-[14px]"
              >
                Готово
              </button>
            </div>
          </div>
        ) : showInvite ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim() || createAgent.isPending) return;
              createAgent.mutate(name.trim(), {
                onSuccess: (res) => {
                  setIssuedToken({
                    name: res.agent.name,
                    token: res.api_token,
                  });
                  setName("");
                  setShowInvite(false);
                },
              });
            }}
            className="p-4"
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Имя агента — например, Гермес"
              className="w-full bg-card2 rounded-xl px-3 py-2.5 text-[16px] text-text placeholder:text-dim outline-none mb-3"
            />
            <ErrorBanner
              error={createAgent.error}
              fallback="Не удалось завести агента"
              variant="block"
              className="mb-3"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={!name.trim() || createAgent.isPending}
                className="tap-scale h-11 px-4 rounded-xl bg-red text-white text-[14px] font-semibold disabled:opacity-40"
              >
                {createAgent.isPending ? "Завожу…" : "Завести"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowInvite(false);
                  setName("");
                }}
                className="tap-scale h-11 px-4 rounded-xl bg-card2 text-sub text-[14px]"
              >
                Отмена
              </button>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setShowInvite(true)}
            className="tap-row w-full flex items-center gap-3 py-3 px-4 border border-dashed border-stroke rounded-2xl"
          >
            <Icon name="plus" size={18} className="text-red" />
            <span className="text-[14px] text-text">Завести агента</span>
          </button>
        )}
      </div>

      {/* Roles */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">
        Роль агента
      </div>
      <div className="bg-card rounded-2xl p-4 space-y-3">
        <div className="flex items-start gap-2">
          <Icon name="crown" size={16} className="text-red mt-0.5 shrink-0" />
          <p className="text-[13px] text-sub leading-relaxed">
            <span className="text-text font-medium">Владелец</span> — полный
            доступ ко всем задачам и настройкам
          </p>
        </div>
        <div className="flex items-start gap-2">
          <Icon name="share" size={16} className="text-blue mt-0.5 shrink-0" />
          <p className="text-[13px] text-sub leading-relaxed">
            <span className="text-text font-medium">Оркестратор</span> — ведёт
            работу ботов: заводит и правит любые задачи и проекты, назначает
            исполнителей, но ничего не удаляет
          </p>
        </div>
        <div className="flex items-start gap-2">
          <Icon name="bot" size={16} className="text-purple mt-0.5 shrink-0" />
          <p className="text-[13px] text-sub leading-relaxed">
            <span className="text-text font-medium">Агент</span> — может
            редактировать назначенные задачи, добавлять комментарии, отмечать
            выполнение
          </p>
        </div>
        <div className="flex items-start gap-2">
          <Icon name="eye" size={16} className="text-dim mt-0.5 shrink-0" />
          <p className="text-[13px] text-sub leading-relaxed">
            <span className="text-text font-medium">Наблюдатель</span> — только
            просмотр
          </p>
        </div>
      </div>
    </div>
  );
}
