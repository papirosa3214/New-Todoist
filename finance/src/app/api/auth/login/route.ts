import { NextResponse } from "next/server";
import { login } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const username = String(body?.username ?? "").trim();
    const password = String(body?.password ?? "");
    if (!username || !password) {
      return NextResponse.json(
        { error: { code: "INVALID_PARAMS", message: "Логин и пароль обязательны" } },
        { status: 400 },
      );
    }
    const user = await login(username, password);
    if (!user) {
      return NextResponse.json(
        { error: { code: "BAD_CREDENTIALS", message: "Неверный логин или пароль" } },
        { status: 401 },
      );
    }
    return NextResponse.json({ user });
  } catch (err) {
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Внутренняя ошибка" } },
      { status: 500 },
    );
  }
}