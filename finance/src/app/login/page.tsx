import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { LoginForm } from "@/components/LoginForm";

export default async function LoginPage() {
  const user = await currentUser();
  if (user) redirect("/dashboard");
  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-white rounded-xl shadow-sm border border-ink-200 p-8">
        <h1 className="text-xl font-semibold mb-2">Финансы</h1>
        <p className="text-ink-600 text-sm mb-6">Войдите, чтобы вести учёт операций.</p>
        <LoginForm />
      </div>
    </main>
  );
}