"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error?.message ?? "Не удалось войти");
        setPending(false);
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError("Сетевая ошибка");
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block">
        <span className="text-sm text-ink-700">Имя пользователя</span>
        <input
          autoFocus
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="mt-1 w-full border border-ink-300 rounded-md px-3 py-2 text-sm"
        />
      </label>
      <label className="block">
        <span className="text-sm text-ink-700">Пароль</span>
        <input
          required
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full border border-ink-300 rounded-md px-3 py-2 text-sm"
        />
      </label>
      {error ? <p className="text-sm text-danger-500">{error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="w-full bg-accent-600 text-white rounded-md py-2 text-sm font-medium hover:bg-accent-700 disabled:opacity-60"
      >
        {pending ? "Входим…" : "Войти"}
      </button>
    </form>
  );
}