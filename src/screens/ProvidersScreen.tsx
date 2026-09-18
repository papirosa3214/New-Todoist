import { useRef, useState } from "react";
import {
  useRuntimeProviders,
  useConnectProvider,
  RUNTIME_PROVIDER_LABEL,
  RUNTIME_PROVIDER_DESCRIPTION,
  type AuthInstruction,
  type ProviderStatus,
} from "../api/runtime";
import {
  ErrorBanner,
  Loading,
  ScreenHeader,
} from "../components/UI";
import { useDialog } from "../components/Dialog";
import { getErrorMessage } from "../lib/errors";

const STATUS_LABEL: Record<ProviderStatus, string> = {
  connected: "Подключён",
  disconnected: "Не подключён",
  expired: "Не отвечает",
};

const STATUS_COLOR: Record<ProviderStatus, string> = {
  connected: "#22C55E",
  disconnected: "#F59E0B",
  expired: "#EF4444",
};

function StatusBadge({ status }: { status: ProviderStatus }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 600,
        color: "#fff",
        background: STATUS_COLOR[status],
      }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function ProviderCard({ id }: { id: string }) {
  const providers = useRuntimeProviders();
  const connect = useConnectProvider();
  const dialog = useDialog();
  const provider = providers.data?.providers.find((p) => p.provider === id);
  const status = provider?.status ?? "expired";
  const authType = provider?.authType ?? null;
  const isApiKey = authType === "api_key";
  const isOAuth = authType === "oauth";
  const [apiKey, setApiKey] = useState("");
  const [showInput, setShowInput] = useState(false);
  const submittingRef = useRef(false);

  // OAuth: показать модалку с командой и инструкцией
  const handleInstruction = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      const result = await connect.mutateAsync({ provider: id });
      if ("status" in result && result.status === "auth_required") {
        const instr = result as AuthInstruction;
        await dialog.alert(
          `${RUNTIME_PROVIDER_LABEL[id]}: авторизация OAuth`,
          `${instr.note}\n\nКоманда:\n${instr.command}`,
        );
      }
    } catch (e) {
      await dialog.alert("Ошибка", getErrorMessage(e));
    } finally {
      submittingRef.current = false;
    }
  };

  const handleSubmitKey = async () => {
    if (!apiKey.trim()) {
      await dialog.alert("Пустой ключ", "Введите api key.");
      return;
    }
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      await connect.mutateAsync({ provider: id, apiKey: apiKey.trim() });
      setApiKey("");
      setShowInput(false);
      await dialog.alert(
        "Готово",
        `${RUNTIME_PROVIDER_LABEL[id]} подключён.`,
      );
    } catch (e) {
      await dialog.alert("Ошибка", getErrorMessage(e));
    } finally {
      submittingRef.current = false;
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 16 }}>
            {RUNTIME_PROVIDER_LABEL[id] ?? id}
          </div>
          <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>
            {RUNTIME_PROVIDER_DESCRIPTION[id] ?? ""}
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      {authType && (
        <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 8 }}>
          auth: {authType}
        </div>
      )}

      {/* Disconnected + api_key: ввод ключа */}
      {(status === "disconnected" || status === "expired") && isApiKey && (
        <div>
          {showInput ? (
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="api key"
                autoComplete="off"
                style={{
                  flex: 1,
                  padding: "8px 10px",
                  border: "1px solid #D1D5DB",
                  borderRadius: 6,
                  fontSize: 14,
                }}
              />
              <button
                type="button"
                onClick={handleSubmitKey}
                disabled={connect.isPending}
                style={{
                  padding: "8px 14px",
                  borderRadius: 6,
                  background: "#2563EB",
                  color: "#fff",
                  fontSize: 14,
                  fontWeight: 600,
                  border: 0,
                  cursor: connect.isPending ? "wait" : "pointer",
                }}
              >
                Подключить
              </button>
              <button
                type="button"
                onClick={() => { setShowInput(false); setApiKey(""); }}
                style={{
                  padding: "8px 12px",
                  borderRadius: 6,
                  background: "#F3F4F6",
                  color: "#374151",
                  fontSize: 14,
                  border: 0,
                  cursor: "pointer",
                }}
              >
                Отмена
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowInput(true)}
              style={{
                padding: "8px 14px",
                borderRadius: 6,
                background: "#2563EB",
                color: "#fff",
                fontSize: 14,
                fontWeight: 600,
                border: 0,
                cursor: "pointer",
              }}
            >
              Ввести api key
            </button>
          )}
        </div>
      )}

      {/* Disconnected + OAuth: инструкция */}
      {(status === "disconnected" || status === "expired") && isOAuth && (
        <button
          type="button"
          onClick={handleInstruction}
          disabled={connect.isPending}
          style={{
            padding: "8px 14px",
            borderRadius: 6,
            background: "#2563EB",
            color: "#fff",
            fontSize: 14,
            fontWeight: 600,
            border: 0,
            cursor: connect.isPending ? "wait" : "pointer",
          }}
        >
          Инструкция по OAuth
        </button>
      )}

      {/* Connected: переподключить (то же, что инструкция для OAuth или
          повторная запись для api_key — простой способ проверить, что
          всё ещё работает). */}
      {status === "connected" && (
        <button
          type="button"
          onClick={isOAuth ? handleInstruction : () => setShowInput(true)}
          disabled={connect.isPending}
          style={{
            padding: "8px 14px",
            borderRadius: 6,
            background: "#F3F4F6",
            color: "#374151",
            fontSize: 14,
            fontWeight: 600,
            border: 0,
            cursor: connect.isPending ? "wait" : "pointer",
          }}
        >
          {isOAuth ? "Переподключить (OAuth)" : "Обновить ключ"}
        </button>
      )}
    </div>
  );
}

export function ProvidersScreen() {
  const providers = useRuntimeProviders();
  const knownOrder = ["anthropic", "openai-codex", "minimax"];

  return (
    <div className="screen" style={{ padding: "16px 16px 80px" }}>
      <ScreenHeader title="Провайдеры" />
      <div style={{ fontSize: 13, color: "#6B7280", marginBottom: 16 }}>
        Источник истины — Pi. Ключи и токены лежат в&nbsp;
        <code>~/.pi/agent/auth.json</code>. TaskFlow читает статус через&nbsp;
        <code>pi auth check --json</code>.
      </div>

      {providers.isLoading && <Loading />}
      {providers.error && (
        <ErrorBanner error={providers.error} />
      )}

      {providers.data?.providers
        .slice()
        .sort((a, b) => knownOrder.indexOf(a.provider) - knownOrder.indexOf(b.provider))
        .map((p) => (
          <ProviderCard key={p.provider} id={p.provider} />
        ))}

      {providers.data?.providers.length === 0 && (
        <div style={{ textAlign: "center", padding: 32, color: "#6B7280" }}>
          Провайдеры не сконфигурированы. Pi не знает ни одного провайдера.
        </div>
      )}
    </div>
  );
}
