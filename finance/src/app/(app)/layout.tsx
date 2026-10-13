import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { AppShell } from "@/components/AppShell";
import { SuccessToastProvider } from "@/components/SuccessToast";
import { TooltipProvider } from "@/components/ui/tooltip";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  return (
    <AppShell username={user.username}>
      <SuccessToastProvider>
        <TooltipProvider delayDuration={200}>
          <div className="flex min-h-full flex-col">
            <div className="flex-1">{children}</div>
            <footer className="border-t border-ink-200 bg-white px-6 py-3">
              <p className="text-xs text-ink-500">
                Расчёты и данные справочные, а не инвестиционная рекомендация. Решение о
                вложениях принимаете вы сами.
              </p>
            </footer>
          </div>
        </TooltipProvider>
      </SuccessToastProvider>
    </AppShell>
  );
}