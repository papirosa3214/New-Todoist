import { useState } from "react";
import {
  useRuntimeModels,
  useRuntimeRouting,
  usePutRouting,
} from "../api/runtime";
import {
  ErrorBanner,
  Loading,
  ScreenHeader,
} from "../components/UI";
import { useDialog } from "../components/Dialog";
import { getErrorMessage } from "../lib/errors";

const ROLE_LABEL: Record<string, string> = {
  researcher: "Исследователь",
  analyst: "Аналитик",
  critic_verifier: "Критик-проверяющий",
  architect: "Архитектор",
  builder: "Разработчик",
  qa: "QA",
  designer: "Дизайнер интерфейсов",
};

const ROLES = [
  "researcher",
  "analyst",
  "critic_verifier",
  "architect",
  "builder",
  "qa",
  "designer",
];

type ModelOption = { id: string; label: string };
type ModelGroup = { provider: string; options: ModelOption[] };

/** Человеческие подписи провайдеров; неизвестный — как есть. */
function providerTitle(provider: string): string {
  const map: Record<string, string> = {
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
  return map[provider] ?? provider;
}

/**
 * Резервные модели (fallbacks) УДАЛЕНЫ из веба (20.09.2026) — не по прихоти,
 * а потому что они нигде не использовались и ни на что не влияли: эскалацию
 * при сбое делает глобальная лесенка (`model_ladder`), а роль-специфичную
 * цепочку primary+fallbacks читала единственная функция `nextModelForProfile`,
 * которая не вызывается. Поэтому в `PUT /api/runtime/routing/:role` уходит
 * пустой список fallbacks — он затирает оставшиеся с прежних времён.
 *
 * В списке — только ДОСТУПНЫЕ модели (`available`: провайдер авторизован),
 * сгруппированы по провайдеру. Каталог Pi отдаёт 1000+ моделей всех
 * провайдеров, включая те, к которым нет ключей.
 */
function ModelSelect({
  role,
  model,
  onChange,
  groups,
}: {
  role: string;
  model: string;
  onChange: (m: string) => void;
  groups: ModelGroup[];
}) {
  const known = groups.some((g) => g.options.some((o) => o.id === model));
  return (
    <div style={{ marginBottom: 4 }}>
      <label
        htmlFor={`primary-${role}`}
        style={{ display: "block", fontSize: 12, color: "#6B7280", marginBottom: 4 }}
      >
        Основная
      </label>
      <select
        id={`primary-${role}`}
        value={model}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          padding: "8px 10px",
          border: "1px solid #D1D5DB",
          borderRadius: 6,
          fontSize: 14,
          background: "#fff",
        }}
      >
        <option value="">— выберите —</option>
        {model !== "" && !known && (
          <optgroup label="Текущая модель">
            <option value={model}>{model}</option>
          </optgroup>
        )}
        {groups.map((g) => (
          <optgroup key={g.provider} label={providerTitle(g.provider)}>
            {g.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

function RoleRow({
  role,
  currentPrimary,
  groups,
}: {
  role: string;
  currentPrimary: string;
  groups: ModelGroup[];
}) {
  const put = usePutRouting();
  const dialog = useDialog();
  const [primary, setPrimary] = useState(currentPrimary);

  // Если из кэша пришли новые значения (другой пользователь поменял) —
  // подтягиваем. Локальный ввод пользователя важнее — но при первом
  // монтировании берём с сервера.
  if (primary === "" && currentPrimary !== "") setPrimary(currentPrimary);

  const dirty = primary !== currentPrimary;

  const handleSave = async () => {
    try {
      await put.mutateAsync({
        role,
        // fallbacks всегда пустые: резервные удалены (см. комментарий выше).
        body: { primary, fallbacks: [] },
      });
    } catch (e) {
      await dialog.alert({ title: "Ошибка", description: getErrorMessage(e) });
    }
  };

  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 12,
        padding: 16,
        marginBottom: 12,
        border: "1px solid #E5E7EB",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 16 }}>
          {ROLE_LABEL[role] ?? role}
        </div>
        {dirty && (
          <button
            type="button"
            onClick={handleSave}
            disabled={put.isPending}
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              background: "#2563EB",
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              border: 0,
              cursor: put.isPending ? "wait" : "pointer",
            }}
          >
            Сохранить
          </button>
        )}
      </div>
      <ModelSelect role={role} model={primary} onChange={setPrimary} groups={groups} />
    </div>
  );
}

export function RolesModelsScreen() {
  const models = useRuntimeModels();
  const routing = useRuntimeRouting();

  // Только доступные модели, сгруппированные по провайдеру (порядок — как в
  // каталоге). Недоступные сюда не попадают.
  const order: string[] = [];
  const byProvider: Record<string, ModelOption[]> = {};
  for (const m of models.data?.models ?? []) {
    if (!m.available) continue;
    if (!byProvider[m.provider]) {
      byProvider[m.provider] = [];
      order.push(m.provider);
    }
    if (byProvider[m.provider].some((o) => o.id === m.id)) continue;
    byProvider[m.provider].push({ id: m.id, label: m.name ?? m.id });
  }
  const groups: ModelGroup[] = order.map((provider) => ({
    provider,
    options: byProvider[provider],
  }));

  return (
    <div className="screen" style={{ padding: "16px 16px 80px" }}>
      <ScreenHeader title="Агенты: модели ролей" />
      <div style={{ fontSize: 13, color: "#6B7280", marginBottom: 16 }}>
        Для каждой из 8 ролей выберите основную модель (доступные,
        сгруппированы по провайдеру). Источник правды —&nbsp;
        <code>server/scripts/role-routing.yaml</code>; меняется через&nbsp;
        <code>PUT /api/runtime/routing/:role</code> (owner/service).
      </div>

      {(models.isLoading || routing.isLoading) && <Loading />}
      {models.error && <ErrorBanner error={models.error} />}
      {routing.error && <ErrorBanner error={routing.error} />}
      {models.data?.models.length === 0 && (
        <div style={{ textAlign: "center", padding: 24, color: "#6B7280" }}>
          Pi не отдаёт ни одной модели. Проверьте&nbsp;
          <code>pi --list-models</code> на хосте .110.
        </div>
      )}
      {models.data != null && models.data.models.length > 0 && groups.length === 0 && (
        <div style={{ textAlign: "center", padding: 24, color: "#6B7280" }}>
          Нет ни одной доступной модели — проверьте ключи провайдеров.
        </div>
      )}

      {routing.data?.routing && (
        <>
          {ROLES.map((role) => (
            <RoleRow
              key={role}
              role={role}
              currentPrimary={routing.data!.routing.models[role] ?? ""}
              groups={groups}
            />
          ))}
        </>
      )}
    </div>
  );
}
