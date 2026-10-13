import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";

export default async function Home() {
  const user = await currentUser();
  if (!user) {
    redirect("/login");
  }
  redirect("/dashboard");
}