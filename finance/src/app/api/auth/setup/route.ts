import { NextResponse } from "next/server";
import { createOwner, login } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Первый запуск: создание владельца, когда в базе ещё нет ни одного пользователя. */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const username = String(body?.username ?? "").trim();
    const password = String(body?.password ?? "");
    if (username.length < 3) {
      return NextResponse.json(
        { error: { code: "INVALID_PARAMS", message: "Логин: минимум 3 символа" } },
        { status: 400 },
      );
    }
    if (password.length < 6) {
      return NextResponse.json(
        { error: { code: "INVALID_PARAMS", message: "Пароль: минимум 6 символов" } },
        { status: 400 },
      );
    }
    const created = await createOwner(username, password);
    if (!created) {
      return NextResponse.json(
        { error: { code: "ALREADY_INITIALIZED", message: "Владелец уже создан" } },
        { status: 409 },
      );
    }
    await login(username, password);
    return NextResponse.json({ user: { username } }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Внутренняя ошибка" } },
      { status: 500 },
    );
  }
}
