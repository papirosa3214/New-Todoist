import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { Sidebar } from "@/components/Sidebar";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  return (
    <div className="min-h-screen flex bg-ink-50">
      <Sidebar username={user.username} />
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}