import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAgents, useCreateAgent } from "../api/agents";
import {
  Icon,
  Avatar,
  ScreenHeader,
  ErrorBanner,
  BackButton,
} from "../components/UI";

export function AgentsScreen() {
  const navigate = useNavigate();
  const { data: agents = [], isLoading, error, isError } = useAgents();
  const createAgent = useCreateAgent();
  const [showInvite, setShowInvite] = useState(false);
  const [name, setName] = useState("");
  // Ключ живёт только здесь, в состоянии экрана: сервер отдаёт его ровно
  // один раз при создании и больше ни одним маршрутом не показывает.
  const [issuedToken, setIssuedToken] = useState<{
    name: string;
    token: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  return (
    <div className="px-4 pb-4">
      <ScreenHeader
        variant="compact"
        leading={<BackButton onClick={() => navigate(-1)} />}
        title="Агенты"
      />

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
      {isLoading && <p className="px-1 text-[13px] text-dim mb-4">Загрузка…</p>}
      <div className="bg-card rounded-2xl overflow-hidden mb-4">
        {agents.map((u) => (
          <div key={u.id} className="flex items-center gap-3 py-3 px-4">
            <Avatar initials={u.initials} color={u.avatar_color} size={36} />
            <div className="flex-1 min-w-0">
              <div className="text-[15px] text-text">{u.name}</div>
            </div>
            <span
              className="text-[12px] font-medium px-2 py-0.5 rounded text-white"
              style={{
                backgroundColor:
                  u.role === "owner"
                    ? "#E44332"
                    : u.type === "ai"
                      ? "#A78BFA"
                      : "#FF9A14",
              }}
            >
              {u.role === "owner" ? "Владелец" : "Агент"}
            </span>
            <div className="flex items-center gap-1.5">
              <div
                className={`w-[7px] h-[7px] rounded-full ${u.status === "online" ? "bg-green" : "bg-dim"}`}
              />
              <span className="text-[12px] text-sub">
                {u.status === "online" ? "Онлайн" : "Офлайн"}
              </span>
            </div>
          </div>
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
