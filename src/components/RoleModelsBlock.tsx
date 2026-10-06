// Блок «Модели ролей» на экране «Модели и провайдеры» (владелец 07.10.2026): основная модель
// каждой роли и строка «Всем ролям» — выбрал модель, раскатилось на все роли сразу.
// Раньше это был отдельный экран «Модели ролей» с белыми карточками и невидимым текстом.
// Сохранение сразу при выборе: запасные модели роли сервер не трогает (PUT без fallbacks).
import { useState } from "react";
import { FieldGroup, Loading, ErrorBanner, SectionHeader } from "./UI";
import { useDialog } from "./Dialog";
import {
  useRuntimeModels,
  useRuntimeRouting,
  usePutRouting,
  usePutRoutingAll,
} from "../api/runtime";
import { getErrorMessage } from "../lib/errors";

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

function ModelSelect({
  value,
  groups,
  placeholder,
  disabled,
  onChange,
  ariaLabel,
}: {
  value: string;
  groups: Group[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (model: string) => void;
  ariaLabel: string;
}) {
  const known = groups.some((g) => g.options.some((o) => o.id === value));
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="bg-card2 text-text tf-action rounded-xl px-3 h-[36px] max-w-[50%] min-w-0 border border-stroke focus:outline-none disabled:opacity-50"
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

function Line({ label, sublabel, children }: { label: string; sublabel?: string; children: React.ReactNode }) {
  return (
    <div className="w-full flex items-center gap-3 px-4 h-control-lg bg-card">
      <span className="flex-1 min-w-0 flex flex-col justify-center">
        <span className="tf-body text-text break-words leading-tight">{label}</span>
        {sublabel && <span className="tf-action text-sub truncate">{sublabel}</span>}
      </span>
      {children}
    </div>
  );
}

export function RoleModelsBlock() {
  const models = useRuntimeModels();
  const routing = useRuntimeRouting();
  const putRole = usePutRouting();
  const putAll = usePutRoutingAll();
  const { confirm, alert, dialog } = useDialog();
  const [busyRole, setBusyRole] = useState<string | null>(null);

  // Только доступные модели (провайдер авторизован), по группам провайдеров.
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
  const roles = [
    ...ROLE_ORDER.filter((r) => r in current),
    ...Object.keys(current).filter((r) => !ROLE_ORDER.includes(r)),
  ];

  const saveRole = async (role: string, primary: string) => {
    if (!primary || primary === current[role]) return;
    setBusyRole(role);
    try {
      await putRole.mutateAsync({ role, body: { primary } });
    } catch (e) {
      await alert({ title: "Не удалось сохранить", description: getErrorMessage(e) });
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
      await alert({ title: "Не удалось сохранить", description: getErrorMessage(e) });
    } finally {
      setBusyRole(null);
    }
  };

  return (
    <section className="mb-6" data-testid="role-models-block">
      {dialog}
      <SectionHeader className="mb-2">Модели ролей</SectionHeader>
      {(models.isLoading || routing.isLoading) && <Loading />}
      {models.error && <ErrorBanner error={models.error} />}
      {routing.error && <ErrorBanner error={routing.error} />}
      {routing.data && groups.length === 0 && !models.isLoading && (
        <div className="tf-meta text-sub px-1">Нет доступных моделей — проверьте подключение провайдеров выше.</div>
      )}
      {routing.data && groups.length > 0 && (
        <FieldGroup>
          <Line label="Всем ролям" sublabel="на всех сразу">
            <ModelSelect
              ariaLabel="Модель для всех ролей"
              value=""
              placeholder="— выбрать —"
              groups={groups}
              disabled={busyRole !== null}
              onChange={saveAll}
            />
          </Line>
          {roles.map((role) => (
            <Line key={role} label={ROLE_LABEL[role] ?? role}>
              <ModelSelect
                ariaLabel={`Модель роли ${ROLE_LABEL[role] ?? role}`}
                value={current[role] ?? ""}
                groups={groups}
                disabled={busyRole !== null}
                onChange={(m) => saveRole(role, m)}
              />
            </Line>
          ))}
        </FieldGroup>
      )}
    </section>
  );
}
