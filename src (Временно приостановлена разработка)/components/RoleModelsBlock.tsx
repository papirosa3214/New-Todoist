// Блок «Модели ролей» на экране «Модели и провайдеры» (владелец 07.10.2026).
//  • два общих тумблера: автопереключение при лимите и автовозврат на основную;
//  • статус: какой провайдер сейчас в лимите (когда вернётся) и кнопка «Вернуть сейчас»;
//  • у каждой роли — основная модель и цепочка запасных, которую владелец собирает сам:
//    сколько угодно запасных, в любом порядке, хоть ни одной («на одной остаюсь»);
//  • строка «Всем ролям» — основная модель сразу на всех.
// Сохранение сразу при выборе.
import { useState } from "react";
import { FieldGroup, ListRow, Switch, Loading, ErrorBanner, SectionHeader, Icon } from "./UI";
import { useDialog } from "./Dialog";
import {
  useRuntimeModels,
  useRuntimeRouting,
  usePutRouting,
  usePutRoutingAll,
  useFailoverStatus,
  usePutFailover,
  useReleaseProviderLimit,
  type FailoverRoleState,
} from "../api/runtime";
import { getErrorMessage } from "../lib/errors";
import { formatAbsoluteTime } from "../lib/date";

const ROLE_ORDER = [
  "researcher",
  "analyst",
  "critic_verifier",
  "architect",
  "builder",
  "qa",
  "designer",
  "secretary",
];

const ROLE_LABEL: Record<string, string> = {
  researcher: "Исследователь",
  analyst: "Аналитик",
  critic_verifier: "Критик-проверяющий",
  architect: "Архитектор",
  builder: "Разработчик",
  qa: "Лайф-тестировщик",
  designer: "Дизайнер интерфейсов",
  secretary: "Секретарь",
};

/** Подписи провайдеров; неизвестный — как есть. */
const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-codex": "OpenAI",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax",
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  google: "Google",
  "google-vertex": "Google",
  ollama: "Ollama (на сервере)",
};

type Group = { provider: string; options: { id: string; label: string }[] };

/** Провайдеры, которые рантайм умеет маршрутизировать по ссылке `провайдер/модель`
 *  (server/src/lib/attemptModel.ts, KNOWN_MODEL_PROVIDERS). Остальные в список не берём. */
const ROUTABLE_PROVIDERS = ["opencode-go", "opencode", "minimax", "anthropic", "openai-codex", "openai", "kimi-coding", "ollama"];

/** Провайдер «по имени модели» — как угадывает сервер (roleRouting.providerOfModel). */
function guessProvider(id: string): string {
  const m = id.toLowerCase();
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3")) return "openai";
  return "minimax";
}

/** Как модель записывается в маршрут: «голый» id, если провайдер угадывается, иначе `провайдер/id`. */
function routeRef(provider: string, id: string): string {
  return guessProvider(id) === provider ? id : `${provider}/${id}`;
}

function move<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function ModelSelect({
  value,
  groups,
  placeholder,
  disabled,
  onChange,
  ariaLabel,
  className = "",
}: {
  value: string;
  groups: Group[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (model: string) => void;
  ariaLabel: string;
  className?: string;
}) {
  const known = groups.some((g) => g.options.some((o) => o.id === value));
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={`bg-card2 text-text tf-action rounded-xl px-3 h-[36px] min-w-0 border border-stroke focus:outline-none disabled:opacity-50 ${className}`}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {value !== "" && !known && (
        <optgroup label="Текущая модель">
          <option value={value}>{value}</option>
        </optgroup>
      )}
      {groups.map((g) => (
        <optgroup key={g.provider} label={PROVIDER_LABEL[g.provider] ?? g.provider}>
          {g.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function IconButton({ name, label, disabled, onClick }: { name: string; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="tap-scale w-11 h-11 shrink-0 flex items-center justify-center text-sub disabled:opacity-30"
    >
      <Icon name={name} size={18} />
    </button>
  );
}

/** Цепочка запасных одной роли: добавить, убрать, переставить; ни одной — тоже допустимо. */
function FallbackEditor({
  role,
  primary,
  fallbacks,
  groups,
  busy,
  onSave,
}: {
  role: string;
  primary: string;
  fallbacks: string[];
  groups: Group[];
  busy: boolean;
  onSave: (fallbacks: string[]) => Promise<void>;
}) {
  // Локальный список: в нём может быть пустая строка — запасная, которую владелец только добавил
  // и ещё не выбрал. На сервер уходят только выбранные.
  const [draft, setDraft] = useState<string[]>(fallbacks);
  const [syncedWith, setSyncedWith] = useState(fallbacks.join("|"));
  const incoming = fallbacks.join("|");
  if (incoming !== syncedWith) {
    // Сервер отдал другой список (например, выбрали «Всем ролям») — берём его.
    setSyncedWith(incoming);
    setDraft(fallbacks);
  }

  const commit = async (next: string[]) => {
    setDraft(next);
    const chosen = Array.from(new Set(next.filter(Boolean)));
    if (chosen.join("|") === fallbacks.join("|")) return;
    await onSave(chosen);
  };

  const label = ROLE_LABEL[role] ?? role;
  return (
    <div className="px-4 pb-3 pt-1">
      <div className="tf-meta text-sub mb-2">
        {draft.length === 0
          ? "Запасных нет: упёрлась в лимит — роль остановится"
          : "Запасные по порядку: после основной — первая, затем вторая…"}
      </div>
      {draft.map((ref, i) => (
        <div key={i} className="flex items-center gap-1 mb-1">
          <span className="tf-meta text-dim w-5 shrink-0">{i + 1}</span>
          <ModelSelect
            ariaLabel={`Запасная ${i + 1} роли ${label}`}
            value={ref}
            groups={groups}
            placeholder="— выберите —"
            disabled={busy}
            className="flex-1"
            onChange={(m) => {
              if (m && m === primary) return; // основная в запасных не повторяется
              void commit(draft.map((r, j) => (j === i ? m : r)));
            }}
          />
          <IconButton name="arrowUp" label="Выше" disabled={busy || i === 0} onClick={() => void commit(move(draft, i, i - 1))} />
          <IconButton name="arrowDown" label="Ниже" disabled={busy || i === draft.length - 1} onClick={() => void commit(move(draft, i, i + 1))} />
          <IconButton name="close" label="Убрать" disabled={busy} onClick={() => void commit(draft.filter((_, j) => j !== i))} />
        </div>
      ))}
      <button
        type="button"
        disabled={busy || draft.includes("")}
        onClick={() => setDraft([...draft, ""])}
        className="tap-scale tf-action text-red h-11 flex items-center gap-1 disabled:opacity-40"
      >
        <Icon name="plus" size={16} /> Добавить запасную
      </button>
    </div>
  );
}

export function RoleModelsBlock() {
  const models = useRuntimeModels();
  const routing = useRuntimeRouting();
  const failover = useFailoverStatus();
  const putRole = usePutRouting();
  const putAll = usePutRoutingAll();
  const putFailover = usePutFailover();
  const release = useReleaseProviderLimit();
  const { confirm, alert, dialog } = useDialog();
  const [busyRole, setBusyRole] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  // Только доступные модели (провайдер авторизован) и только те, что рантайм умеет маршрутизировать.
  const order: string[] = [];
  const byProvider: Record<string, Group["options"]> = {};
  for (const m of models.data?.models ?? []) {
    if (!m.available || !ROUTABLE_PROVIDERS.includes(m.provider)) continue;
    if (!byProvider[m.provider]) {
      byProvider[m.provider] = [];
      order.push(m.provider);
    }
    const ref = routeRef(m.provider, m.id);
    if (byProvider[m.provider].some((o) => o.id === ref)) continue;
    byProvider[m.provider].push({ id: ref, label: m.name ?? m.id });
  }
  const groups: Group[] = order.map((provider) => ({ provider, options: byProvider[provider] }));

  const current = routing.data?.routing.models ?? {};
  const fallbacksOf = routing.data?.routing.fallbacks ?? {};
  const states: Record<string, FailoverRoleState> = Object.fromEntries((failover.data?.roles ?? []).map((r) => [r.role, r]));
  const roles = [
    ...ROLE_ORDER.filter((r) => r in current),
    ...Object.keys(current).filter((r) => !ROLE_ORDER.includes(r)),
  ];

  const fail = async (e: unknown) => alert({ title: "Не удалось сохранить", description: getErrorMessage(e) });

  const savePrimary = async (role: string, primary: string) => {
    if (!primary || primary === current[role]) return;
    setBusyRole(role);
    try {
      await putRole.mutateAsync({ role, body: { primary } });
    } catch (e) {
      await fail(e);
    } finally {
      setBusyRole(null);
    }
  };

  const saveChain = async (role: string, fallbacks: string[]) => {
    setBusyRole(role);
    try {
      await putRole.mutateAsync({ role, body: { primary: current[role], fallbacks } });
    } catch (e) {
      await fail(e);
    } finally {
      setBusyRole(null);
    }
  };

  const saveAll = async (primary: string) => {
    if (!primary) return;
    const ok = await confirm({
      title: "Поставить эту модель всем ролям?",
      description: `Основная модель каждой роли станет «${primary}». Запасные остаются как есть.`,
      confirmLabel: "Поставить всем",
    });
    if (!ok) return;
    setBusyRole("*");
    try {
      await putAll.mutateAsync(primary);
    } catch (e) {
      await fail(e);
    } finally {
      setBusyRole(null);
    }
  };

  const toggle = async (body: { auto_switch?: boolean; auto_return?: boolean }) => {
    try {
      await putFailover.mutateAsync(body);
    } catch (e) {
      await fail(e);
    }
  };

  const status = failover.data;

  return (
    <section className="mb-6" data-testid="role-models-block">
      {dialog}
      {(models.isLoading || routing.isLoading) && <Loading />}
      {models.error && <ErrorBanner error={models.error} />}
      {routing.error && <ErrorBanner error={routing.error} />}

      {status && (
        <>
          <SectionHeader className="mb-2">Автопереключение моделей</SectionHeader>
          <FieldGroup>
            <ListRow
              label="Автопереключение при лимите"
              sublabel="упёрлась в лимит — идёт на следующую модель цепочки"
              trailing={<Switch checked={status.auto_switch} onChange={(v) => toggle({ auto_switch: v })} ariaLabel="Автопереключение при лимите" />}
            />
            <ListRow
              label="Автовозврат на основную"
              sublabel="лимит сбросился — снова основная модель"
              trailing={<Switch checked={status.auto_return} onChange={(v) => toggle({ auto_return: v })} ariaLabel="Автовозврат на основную модель" />}
            />
            {status.limits.map((l) => (
              <ListRow
                key={l.provider}
                label={`${PROVIDER_LABEL[l.provider] ?? l.provider} в лимите`}
                sublabel={l.held ? "вернётся только по вашей кнопке" : `вернётся после ${formatAbsoluteTime(l.until)}`}
                trailing={
                  <button
                    type="button"
                    disabled={release.isPending}
                    onClick={() => release.mutate(l.provider, { onError: fail })}
                    className="tap-scale tf-action text-red h-11 px-1 disabled:opacity-40"
                  >
                    Вернуть сейчас
                  </button>
                }
              />
            ))}
          </FieldGroup>
        </>
      )}

      <SectionHeader className="mb-2 mt-6">Модели ролей</SectionHeader>
      {routing.data && groups.length === 0 && !models.isLoading && (
        <div className="tf-meta text-sub px-1">Нет доступных моделей — проверьте подключение провайдеров ниже.</div>
      )}
      {routing.data && groups.length > 0 && (
        <FieldGroup>
          <ListRow
            label="Всем ролям"
            sublabel="основная модель на всех сразу"
            trailing={
              <ModelSelect
                ariaLabel="Модель для всех ролей"
                value=""
                placeholder="— выбрать —"
                groups={groups}
                disabled={busyRole !== null}
                className="max-w-[50%]"
                onChange={saveAll}
              />
            }
          />
          {roles.map((role) => {
            const st = states[role];
            const chain = fallbacksOf[role] ?? [];
            const isOpen = open === role;
            const currentLabel = groups.flatMap((g) => g.options).find((o) => o.id === st?.current)?.label ?? st?.current;
            const sub = st?.on_fallback
              ? `сейчас на запасной: ${currentLabel}`
              : chain.length === 0
                ? "запасных нет"
                : `запасных: ${chain.length}`;
            return (
              <div key={role}>
                <div className="w-full flex items-center gap-3 px-4 min-h-[52px] bg-card">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={`Цепочка запасных: ${ROLE_LABEL[role] ?? role}`}
                    onClick={() => setOpen(isOpen ? null : role)}
                    className="flex-1 min-w-0 flex items-center gap-2 text-left min-h-[44px]"
                  >
                    <span className="flex-1 min-w-0 flex flex-col justify-center">
                      <span className="tf-body text-text break-words leading-tight">{ROLE_LABEL[role] ?? role}</span>
                      <span className={`tf-action break-words ${st?.on_fallback ? "text-coral" : "text-sub"}`}>{sub}</span>
                    </span>
                    <Icon name={isOpen ? "chevronUp" : "chevronDown"} size={14} className="text-dim shrink-0" />
                  </button>
                  <ModelSelect
                    ariaLabel={`Модель роли ${ROLE_LABEL[role] ?? role}`}
                    value={current[role] ?? ""}
                    groups={groups}
                    disabled={busyRole !== null}
                    className="max-w-[44%]"
                    onChange={(m) => savePrimary(role, m)}
                  />
                </div>
                {isOpen && (
                  <div className="bg-card">
                    <FallbackEditor
                      role={role}
                      primary={current[role] ?? ""}
                      fallbacks={chain}
                      groups={groups}
                      busy={busyRole !== null}
                      onSave={(fb) => saveChain(role, fb)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </FieldGroup>
      )}
    </section>
  );
}
