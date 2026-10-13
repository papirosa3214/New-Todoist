"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Rocket } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorBanner } from "@/components/ErrorBanner";

/** Первый запуск: приложение ещё не настроено — создаём владельца. */
export function SetupForm() {
  const router = useRouter();
  const [username, setUsername] = React.useState("owner");
  const [password, setPassword] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error?.message ?? "Не удалось создать владельца");
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Нет связи с сервером. Проверьте подключение и повторите.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="flex items-center gap-2 text-base text-ink-700">
        <Rocket className="h-5 w-5 text-accent-700" aria-hidden="true" />
        <span>Приложение ещё не настроено</span>
      </div>
      <div className="space-y-1">
        <Label htmlFor="setup-user">Логин владельца</Label>
        <Input
          id="setup-user"
          name="username"
          required
          minLength={3}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="setup-pass">Пароль</Label>
        <Input
          id="setup-pass"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error ? <ErrorBanner message={error} /> : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Создаём…" : "Создать владельца"}
      </Button>
    </form>
  );
}