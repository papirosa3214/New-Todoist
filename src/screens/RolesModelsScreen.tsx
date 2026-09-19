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
  synthesizer: "Синтезатор",
  critic_verifier: "Критик-проверяющий",
  architect: "Архитектор",
  builder: "Разработчик",
  qa: "QA",
  designer: "Дизайнер интерфейсов",
};

const ROLES = [
  "researcher",
  "analyst",
  "synthesizer",
  "critic_verifier",
  "architect",
  "builder",
  "qa",
  "designer",
];

function ModelSelect({
  role,
  model,
  onChange,
  options,
}: {
  role: string;
  model: string;
  onChange: (m: string) => void;
  options: string[];
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label
        htmlFor={`primary-${role}`}
        style={{ display: "block", fontSize: 12, color: "#6B7280", marginBottom: 4 }}
      >
        Primary
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
        {options.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
    </div>
  );
}

function FallbackPicker({
  fallbacks,
  primary,
  onChange,
  options,
}: {
  role: string;
  fallbacks: string[];
  primary: string;
  onChange: (f: string[]) => void;
  options: string[];
}) {
  // Список УПОРЯДОЧЕН (спека §15): Sonnet → Sol → MiniMax и
  // Sonnet → MiniMax → Sol — это разные routing. Поэтому выбранные
  // fallbacks показываются по порядку с перемещением ↑/↓, а не сортируются.
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= fallbacks.length) return;
    const next = [...fallbacks];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const available = options.filter(
    (m) => m !== primary && !fallbacks.includes(m),
  );
  return (
    <div style={{ marginBottom: 12 }}>
      <label
        style={{ display: "block", fontSize: 12, color: "#6B7280", marginBottom: 4 }}
      >
        Fallbacks (по убыванию приоритета)
      </label>
      {fallbacks.length === 0 && (
        <div style={{ fontSize: 12, color: "#9CA3AF", marginBottom: 6 }}>
          не выбраны
        </div>
      )}
      {fallbacks.map((m, index) => (
        <div
          key={m}
          style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}
        >
          <span style={{ flex: 1, fontSize: 13 }}>
            {index + 1}. {m}
          </span>
          <button
            type="button"
            aria-label={`поднять ${m}`}
            onClick={() => move(index, -1)}
            disabled={index === 0}
            style={{
              padding: "4px 8px",
              borderRadius: 6,
              border: "1px solid #D1D5DB",
              background: "#fff",
              cursor: index === 0 ? "default" : "pointer",
            }}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={`опустить ${m}`}
            onClick={() => move(index, 1)}
            disabled={index === fallbacks.length - 1}
            style={{
              padding: "4px 8px",
              borderRadius: 6,
              border: "1px solid #D1D5DB",
              background: "#fff",
              cursor: index === fallbacks.length - 1 ? "default" : "pointer",
            }}
          >
            ↓
          </button>
          <button
            type="button"
            aria-label={`убрать ${m}`}
            onClick={() => onChange(fallbacks.filter((x) => x !== m))}
            style={{
              padding: "4px 8px",
              borderRadius: 6,
              border: "1px solid #D1D5DB",
              background: "#fff",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>
      ))}
      {available.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {available.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onChange([...fallbacks, m])}
              style={{
                padding: "6px 10px",
                borderRadius: 16,
                fontSize: 12,
                border: "1px solid #D1D5DB",
                background: "#fff",
                color: "#374151",
                cursor: "pointer",
              }}
            >
              + {m}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RoleRow({
  role,
  currentPrimary,
  currentFallbacks,
  options,
}: {
  role: string;
  currentPrimary: string;
  currentFallbacks: string[];
  options: string[];
}) {
  const put = usePutRouting();
  const dialog = useDialog();
  const [primary, setPrimary] = useState(currentPrimary);
  const [fallbacks, setFallbacks] = useState(currentFallbacks);

  // Если из кэша пришли новые значения (другой пользователь поменял) —
  // подтягиваем. Локальный ввод пользователя важнее — но при первом
  // монтировании берём с сервера.
  if (primary === "" && currentPrimary !== "") setPrimary(currentPrimary);
  if (fallbacks.length === 0 && currentFallbacks.length > 0) {
    setFallbacks(currentFallbacks);
  }

  // Сравниваем порядок как есть: сортировка здесь теряла пользовательский
  // порядок fallback'ов (спека §15) и делала список «грязным» лишь по составу.
  const dirty =
    primary !== currentPrimary ||
    fallbacks.join("\u0000") !== currentFallbacks.join("\u0000");

  const handleSave = async () => {
    try {
      await put.mutateAsync({
        role,
        body: { primary, fallbacks },
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
      <ModelSelect role={role} model={primary} onChange={setPrimary} options={options} />
      <FallbackPicker
        role={role}
        fallbacks={fallbacks}
        primary={primary}
        onChange={setFallbacks}
        options={options}
      />
    </div>
  );
}

export function RolesModelsScreen() {
  const models = useRuntimeModels();
  const routing = useRuntimeRouting();

  // Опции для select — список id моделей, доступных в Pi.
  const options = (models.data?.models ?? []).map((m) => m.id).sort();

  return (
    <div className="screen" style={{ padding: "16px 16px 80px" }}>
      <ScreenHeader title="Агенты: модели ролей" />
      <div style={{ fontSize: 13, color: "#6B7280", marginBottom: 16 }}>
        Для каждой из 8 ролей выберите primary и fallbacks. Источник правды —&nbsp;
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

      {routing.data?.routing && (
        <>
          {ROLES.map((role) => (
            <RoleRow
              key={role}
              role={role}
              currentPrimary={routing.data!.routing.models[role] ?? ""}
              currentFallbacks={routing.data!.routing.fallbacks[role] ?? []}
              options={options}
            />
          ))}
        </>
      )}
    </div>
  );
}
