import { NextResponse } from "next/server";
import { logout } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  await logout();
  return NextResponse.json({ ok: true });
}