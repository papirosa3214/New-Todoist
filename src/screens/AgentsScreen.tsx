import { useRef, useState } from "react";

import {
  useAgents,
  useCreateAgent,
  useRenameAgent,
  useDeleteAgent,
} from "../api/agents";
import { useRoles, type RoleDetails } from "../api/roles";
import { useCurrentUser } from "../api/auth";
import { API_BASE_URL, getToken } from "../api/client";
import { RoleContextSheet } from "../components/RoleContextSheet";
import { useUploadAvatar, useDeleteAvatar } from "../api/avatars";
import {
  FieldGroup,
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

type PiRoleMeta = {
  label: string;
  invocation: string;
  purpose: string;
  specialization: string;
};

const PI_ROLE_META: Record<string, PiRoleMeta> = {
  researcher: {
    label: "Исследователь",
    invocation: "--mcp-config ~/.pi/agent/taskflow-profiles/researcher.json",
    purpose: "Ищет источники, собирает факты и проверяет их.",
    specialization: "Веб-поиск · источники · проверка цитат",
  },
  analyst: {
    label: "Аналитик",
    invocation: "--mcp-config ~/.pi/agent/taskflow-profiles/analyst.json",
    purpose: "Сравнивает данные, находит закономерности и риски.",
    specialization: "Расчёты · таблицы · структурирование данных",
  },
  critic_verifier: {
    label: "Критик-проверяющий",
    invocation:
      "--mcp-config ~/.pi/agent/taskflow-profiles/critic_verifier.json",
    purpose: "Ищет ошибки, противоречия и пропуски.",
    specialization: "Ревью · проверки · контроль рисков",
  },
  architect: {
    label: "Архитектор",
    invocation: "--mcp-config ~/.pi/agent/taskflow-profiles/architect.json",
    purpose: "Проектирует структуру решения и границы компонентов.",
    specialization: "Архитектура · API · технические решения",
  },
  builder: {
    label: "Разработчик",
    invocation: "--mcp-config ~/.pi/agent/taskflow-profiles/builder.json",
    purpose: "Реализует изменения в коде и конфигурации.",
    specialization: "Bash · Git · тесты · отладка",
  },
  qa: {
    label: "QA",
    invocation: "--mcp-config ~/.pi/agent/taskflow-profiles/qa.json",
    purpose: "Проверяет готовый результат и регрессии.",
    specialization: "Тест-планы · логи · воспроизведение ошибок",
  },
  designer: {
    label: "Дизайнер интерфейсов",
    invocation: "--mcp-config ~/.pi/agent/taskflow-profiles/designer.json",
    purpose: "Проектирует веб- и мобильный интерфейс.",
    specialization: "Frontend design · mobile design · accessibility",
  },
};

function piRoleMeta(agent: ApiUser) {
  return agent.type === "ai" ? PI_ROLE_META[String(agent.role)] : undefined;
}

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
  const roleMeta = piRoleMeta(agent);
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
    <div
      data-hswipe
      className="relative overflow-hidden"
      onPointerDown={swipe.onPointerDown}
    >
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
          <div className="text-[15px] text-text truncate">
            {roleMeta?.label ?? agent.name}
          </div>
          {roleMeta && (
            <>
              <div className="text-[12px] text-sub leading-4 mt-0.5">
                {roleMeta.purpose}
              </div>
              <div className="text-[11px] text-dim leading-4 break-words">
                Pi-агент · {roleMeta.invocation}
              </div>
              <div className="text-[11px] text-dim leading-4 break-words">
                TaskFlow: полный доступ · {roleMeta.specialization}
              </div>
            </>
          )}
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

// ── Роли: живые профили из GET /api/roles ──────────────────────────────
//
// Показывает не учётки-личности (это список «Команда» ниже), а восемь
// компетенций с их фактической конфигурацией: тем самым промптом,
// набором инструментов и моделью, с которыми реально стартует
// исполнитель. Своей копии настроек здесь нет — иначе экран показывал бы
// одно, а запускалось бы другое.

/** Точка состояния. Красный — только там, где нужно внимание владельца:
 *  сломана сама роль или она упёрлась. «Работает» — нормальный ход дел,
 *  он не тревога; «Готова» — покой, и подсвечивать его нечем.
 *
 *  Остановленный исполнитель точку НЕ красит: причина общая для всех
 *  восьми, она сказана один раз строкой над списком. Иначе экран
 *  показывал бы восемь тревог там, где поломка одна и чинится в другом
 *  месте. */
function roleDotClass(role: RoleDetails): string {
  if (role.problems.length > 0 || role.status === "blocked") return "bg-red";
  if (role.status === "working") return "bg-text";
  return "bg-dim";
}

function RoleRow({ role }: { role: RoleDetails }) {
  const [open, setOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left tap-row"
      >
        <span
          className={`shrink-0 w-2 h-2 rounded-full ${roleDotClass(role)}`}
          aria-hidden
        />
        <span className="flex-1 min-w-0">
          <span className="block text-[15px] text-text truncate">
            {role.title}
          </span>
          <span className="block text-[12px] text-sub truncate">
            {role.status_title}
            {role.current_task ? ` · ${role.current_task.title}` : ""}
          </span>
        </span>
        <Icon
          name={open ? "chevronUp" : "chevronDown"}
          size={16}
          className="shrink-0 text-dim"
        />
      </button>

      {open && (
        <div className="px-4 pb-3 -mt-1">
          {role.problems.length > 0 && (
            <p className="text-[12px] text-red mb-2">
              {role.problems.join(". ")}
            </p>
          )}

          <dl className="text-[12px] mb-2">
            <div className="flex gap-2">
              <dt className="text-dim shrink-0">Модель</dt>
              <dd className="text-sub truncate">{role.model || "не задана"}</dd>
            </div>
            {role.default_shell && (
              <div className="flex gap-2">
                <dt className="text-dim shrink-0">Оболочка</dt>
                <dd className="text-sub truncate">
                  {role.default_shell}
                  {role.fallbacks?.length
                    ? ` → ${role.fallbacks.join(" → ")}`
                    : ""}
                </dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt className="text-dim shrink-0">Инструментов</dt>
              <dd className="text-sub">{role.tools.length}</dd>
            </div>
          </dl>

          {role.skills.length > 0 && (
            <p className="text-[12px] text-sub mb-2">
              {role.skills.map((s) => s.skill_name).join(", ")}
            </p>
          )}

          {/* Промпт — то, с чем роль реально стартует. Показываем начало:
              целиком это несколько экранов текста, а убедиться нужно, что
              он вообще есть и тот самый. */}
          {role.prompt ? (
            <p className="text-[12px] text-dim whitespace-pre-wrap line-clamp-4">
              {role.prompt}
            </p>
          ) : (
            <p className="text-[12px] text-red">Системный промпт не найден</p>
          )}

          {/* Полный редактор контекста запуска — вкладки по режимам,
              каждый слой с источником, историей и (для редактируемых)
              кнопкой «Изменить» / «Сброс» / «История». Карточка
              15c2db1f, дизайн заметки 54ff50a1, §9. */}
          <button
            type="button"
            onClick={() => setContextOpen(true)}
            className="tap-scale h-9 px-3 rounded-xl bg-card2 text-text text-[13px] font-semibold mt-2 flex items-center gap-1"
          >
            <Icon name="edit" size={14} className="text-sub" />
            Контекст запуска
          </button>
        </div>
      )}
      <RoleContextSheet
        open={contextOpen}
        onClose={() => setContextOpen(false)}
        role={role}
        apiBase={API_BASE_URL}
        token={getToken()}
      />
    </div>
  );
}

export function AgentsScreen() {
  const { data: agents = [], isLoading, error, isError } = useAgents();
  const {
    data: roles = [],
    isLoading: rolesLoading,
    error: rolesError,
    isError: rolesIsError,
  } = useRoles();
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

      {/* Роли — компетенции и их живая конфигурация. Отдельно от списка
          учёток ниже: там «кто заведён в системе», здесь «что умеет и чем
          занята» — это разные вопросы, и мешать их в один список значит не
          ответить ни на один. */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2 mt-2">
        Роли
      </div>
      <ErrorBanner
        error={rolesIsError ? rolesError : null}
        fallback="Не удалось загрузить профили ролей"
        variant="block"
        className="mb-2"
      />
      {rolesLoading && <Loading className="mb-4" />}
      {/* Общая причина — одной строкой. Исполнитель один на все роли:
          пока он стоит, работать некому, какой бы исправной ни была
          конфигурация. Тумблер автономки — в настройках. */}
      {!rolesLoading && roles.length > 0 && !roles[0].runtime_ready && (
        <p className="text-[12px] text-sub px-1 mb-2">
          Исполнитель не запущен — роли настроены, но работать некому.
          Включите автономный режим в настройках.
        </p>
      )}
      <div className="mb-4">
        <FieldGroup>
          {roles.map((r) => (
            <RoleRow key={r.role} role={r} />
          ))}
          {!rolesLoading && roles.length === 0 && (
            <div className="px-4 py-3 text-[13px] text-dim">Ролей нет</div>
          )}
        </FieldGroup>
      </div>

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
      <div className="mb-4">
        <FieldGroup>
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
        </FieldGroup>
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

      {/* Passport */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">
        Роли Pi-агента
      </div>
      <div className="bg-card rounded-2xl overflow-hidden mb-4">
        {Object.entries(PI_ROLE_META).map(([role, meta]) => (
          <div
            key={role}
            className="flex items-start gap-3 px-4 py-3 border-b border-stroke last:border-b-0"
          >
            <Icon
              name="bot"
              size={18}
              className="text-purple mt-0.5 shrink-0"
            />
            <div className="min-w-0">
              <div className="text-[14px] text-text font-medium">
                {meta.label}
              </div>
              <div className="text-[12px] text-sub leading-4 mt-0.5">
                {meta.purpose}
              </div>
              <div className="text-[11px] text-dim leading-4 mt-0.5">
                {meta.specialization}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Access levels */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">
        Уровни доступа в TaskFlow
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
