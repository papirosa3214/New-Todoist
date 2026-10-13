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
        <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
      </SuccessToastProvider>
    </AppShell>
  );
}