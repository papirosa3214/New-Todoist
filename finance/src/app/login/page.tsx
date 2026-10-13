import { redirect } from "next/navigation";
import { currentUser, hasOwner } from "@/lib/session";
import { LoginForm } from "@/components/LoginForm";
import { SetupForm } from "@/components/SetupForm";

export default async function LoginPage() {
  const user = await currentUser();
  if (user) redirect("/dashboard");

  // Первый запуск: базы или владельца ещё нет — предлагаем настроить.
  const initialized = await hasOwner().catch(() => true);

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      {/* Единственное место с тенью — карточка входа (раздел 2.1). */}
      <div className="w-full max-w-sm rounded-xl border border-ink-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold leading-8 text-ink-900">Финансы</h1>
        <p className="mb-6 mt-1 text-base text-ink-500">
          {initialized
            ? "Войдите, чтобы вести учёт операций"
            : "Приложение запускается первый раз"}
        </p>
        {initialized ? <LoginForm /> : <SetupForm />}
      </div>
    </main>
  );
}