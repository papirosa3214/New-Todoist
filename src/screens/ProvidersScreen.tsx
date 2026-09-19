import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  useRuntimeProviders,
  useConnectProvider,
  useStartAuthSession,
  useAuthSession,
  useSubmitAuthInput,
  useCancelAuthSession,
  RUNTIME_PROVIDER_LABEL,
  RUNTIME_PROVIDER_DESCRIPTION,
  type ProviderStatus,
  type AuthMethod,
} from "../api/runtime";
import { ErrorBanner, Loading, ScreenHeader } from "../components/UI";
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

const primaryButton: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  background: "#2563EB",
  color: "#fff",
  fontSize: 14,
  fontWeight: 600,
  border: 0,
  cursor: "pointer",
};

const secondaryButton: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  background: "#F3F4F6",
  color: "#374151",
  fontSize: 14,
  border: 0,
  cursor: "pointer",
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

/** Поток OAuth: опрашивает AuthSession, показывает auth_url/device_code/
 *  prompt и передаёт ввод обратно в Pi через POST /auth/:id/input. */
function AuthSessionPanel({
  sessionId,
  provider,
  onClose,
}: {
  sessionId: string;
  provider: string;
  onClose: () => void;
}) {
  const session = useAuthSession(sessionId);
  const submit = useSubmitAuthInput();
  const cancel = useCancelAuthSession();
  const [value, setValue] = useState("");
  const notified = useRef(false);
  const view = session.data;

  useEffect(() => {
    if (view?.status === "connected" && !notified.current) {
      notified.current = true;
    }
  }, [view?.status]);

  if (session.isLoading && !view) return <Loading />;
  if (!view) return null;

  if (view.status === "connected") {
    return (
      <div style={{ marginTop: 10, padding: 10, background: "#F0FDF4", borderRadius: 8 }}>
        <div style={{ color: "#15803D", fontWeight: 600, marginBottom: 8 }}>
          {RUNTIME_PROVIDER_LABEL[provider] ?? provider}: подключён
        </div>
        <button type="button" style={secondaryButton} onClick={onClose}>
          Закрыть
        </button>
      </div>
    );
  }

  if (view.status === "failed" || view.status === "cancelled") {
    return (
      <div style={{ marginTop: 10, padding: 10, background: "#FEF2F2", borderRadius: 8 }}>
        <div style={{ color: "#B91C1C", marginBottom: 8 }}>
          {view.status === "cancelled"
            ? "Авторизация отменена"
            : `Ошибка авторизации: ${view.error ?? "неизвестно"}`}
        </div>
        <button type="button" style={secondaryButton} onClick={onClose}>
          Закрыть
        </button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10, padding: 10, background: "#F9FAFB", borderRadius: 8 }}>
      {view.events.map((event) => {
        if (event.type === "auth_url" && typeof event.data.url === "string") {
          return (
            <div key={event.seq} style={{ marginBottom: 8 }}>
              <a href={event.data.url} target="_blank" rel="noreferrer">
                Открыть страницу авторизации
              </a>
              {typeof event.data.instructions === "string" && (
                <div style={{ fontSize: 12, color: "#6B7280", marginTop: 4 }}>
                  {event.data.instructions}
                </div>
              )}
            </div>
          );
        }
        if (event.type === "device_code") {
          return (
            <div key={event.seq} style={{ marginBottom: 8, fontSize: 13 }}>
              Код: <code>{String(event.data.userCode)}</code> —{" "}
              <a href={String(event.data.verificationUri)} target="_blank" rel="noreferrer">
                {String(event.data.verificationUri)}
              </a>
            </div>
          );
        }
        if (event.type === "progress" || event.type === "info") {
          return (
            <div key={event.seq} style={{ fontSize: 12, color: "#6B7280" }}>
              {String(event.data.message ?? "")}
            </div>
          );
        }
        return null;
      })}

      <div style={{ fontSize: 12, color: "#6B7280", margin: "8px 0" }}>
        Статус: {view.status}
      </div>

      {view.currentPrompt?.type === "select" && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            {view.currentPrompt.message}
          </div>
          {(view.currentPrompt.options ?? []).map((option) => (
            <button
              key={option.id}
              type="button"
              style={{ ...secondaryButton, display: "block", width: "100%", textAlign: "left", marginBottom: 4 }}
              disabled={submit.isPending}
              onClick={() =>
                submit.mutate({ id: sessionId, value: option.id, type: "select" })
              }
            >
              {option.label}
              {option.description && (
                <span style={{ display: "block", fontSize: 11, color: "#6B7280" }}>
                  {option.description}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {view.currentPrompt && view.currentPrompt.type !== "select" && (
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            type={view.currentPrompt.type === "secret" ? "password" : "text"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={view.currentPrompt.placeholder ?? view.currentPrompt.message}
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
            style={primaryButton}
            disabled={submit.isPending || !value.trim()}
            onClick={() =>
              submit.mutate({
                id: sessionId,
                value: value.trim(),
                type: view.currentPrompt?.type,
              })
            }
          >
            Отправить
          </button>
        </div>
      )}

      <button
        type="button"
        style={secondaryButton}
        disabled={cancel.isPending}
        onClick={() => cancel.mutate(sessionId, { onSuccess: onClose })}
      >
        Отмена
      </button>
    </div>
  );
}

function ProviderCard({
  id,
  onOAuth,
}: {
  id: string;
  onOAuth: (provider: string) => void;
}) {
  const providers = useRuntimeProviders();
  const connect = useConnectProvider();
  const dialog = useDialog();
  const provider = providers.data?.providers.find((p) => p.provider === id);
  const status = provider?.status ?? "expired";
  const authMethods: AuthMethod[] = provider?.authMethods?.length
    ? provider.authMethods
    : provider?.authType === "api_key"
    ? ["api_key"]
    : provider?.authType === "oauth"
    ? ["oauth"]
    : [];
  const supportsOAuth = authMethods.includes("oauth");
  const supportsApiKey = authMethods.includes("api_key");
  const [apiKey, setApiKey] = useState("");
  const [showInput, setShowInput] = useState(false);
  const submittingRef = useRef(false);

  const handleSubmitKey = async () => {
    if (!apiKey.trim()) {
      await dialog.alert({ title: "Пустой ключ", description: "Введите api key." });
      return;
    }
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      await connect.mutateAsync({ provider: id, apiKey: apiKey.trim() });
      setApiKey("");
      setShowInput(false);
      await dialog.alert({
        title: "Готово",
        description: `${RUNTIME_PROVIDER_LABEL[id] ?? id} подключён.`,
      });
    } catch (e) {
      await dialog.alert({ title: "Ошибка", description: getErrorMessage(e) });
    } finally {
      submittingRef.current = false;
    }
  };

  const disconnected = status === "disconnected" || status === "expired";

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
            {provider?.name ?? RUNTIME_PROVIDER_LABEL[id] ?? id}
          </div>
          <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>
            {RUNTIME_PROVIDER_DESCRIPTION[id] ?? ""}
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      {provider?.authType && (
        <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 8 }}>
          auth: {provider.authType}
        </div>
      )}

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
          <button type="button" onClick={handleSubmitKey} disabled={connect.isPending} style={primaryButton}>
            Подключить
          </button>
          <button
            type="button"
            onClick={() => { setShowInput(false); setApiKey(""); }}
            style={secondaryButton}
          >
            Отмена
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {supportsOAuth && (
            <button type="button" style={primaryButton} onClick={() => onOAuth(id)}>
              {disconnected ? "Подключить (OAuth)" : "Переподключить (OAuth)"}
            </button>
          )}
          {supportsApiKey && (
            <button
              type="button"
              style={supportsOAuth ? secondaryButton : primaryButton}
              onClick={() => setShowInput(true)}
            >
              {provider?.authType === "api_key" && status === "connected"
                ? "Обновить ключ"
                : "Ввести api key"}
            </button>
          )}
          {!supportsOAuth && !supportsApiKey && (
            <span style={{ fontSize: 12, color: "#9CA3AF" }}>
              Pi не объявил способ авторизации для этого провайдера.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function ProvidersScreen() {
  const providers = useRuntimeProviders();
  const startAuth = useStartAuthSession();
  const dialog = useDialog();
  const [session, setSession] = useState<{ id: string; provider: string } | null>(null);

  const handleOAuth = async (provider: string) => {
    try {
      const result = await startAuth.mutateAsync(provider);
      setSession({ id: result.authSessionId, provider });
    } catch (e) {
      await dialog.alert({ title: "Ошибка", description: getErrorMessage(e) });
    }
  };

  const knownOrder = ["anthropic", "openai-codex", "minimax"];
  const ordered = (providers.data?.providers ?? [])
    .slice()
    .sort((a, b) => {
      const ai = knownOrder.indexOf(a.provider);
      const bi = knownOrder.indexOf(b.provider);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

  return (
    <div className="screen" style={{ padding: "16px 16px 80px" }}>
      <ScreenHeader title="Провайдеры" />
      <div style={{ fontSize: 13, color: "#6B7280", marginBottom: 16 }}>
        Источник истины — Pi. Список провайдеров и статус подключения TaskFlow
        читает у Pi; ключи и токены в TaskFlow не хранятся.
      </div>

      {providers.isLoading && <Loading />}
      {providers.error && <ErrorBanner error={providers.error} />}

      {ordered.map((p) => (
        <div key={p.provider}>
          <ProviderCard id={p.provider} onOAuth={handleOAuth} />
          {session?.provider === p.provider && (
            <AuthSessionPanel
              sessionId={session.id}
              provider={p.provider}
              onClose={() => setSession(null)}
            />
          )}
        </div>
      ))}

      {ordered.length === 0 && (
        <div style={{ textAlign: "center", padding: 32, color: "#6B7280" }}>
          Pi не отдаёт ни одного провайдера.
        </div>
      )}
    </div>
  );
}
