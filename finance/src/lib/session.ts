/**
 * Простая серверная сессия: 32-байтный токен в HTTP-only куке,
 * строка в таблице `sessions`. argon2id для пароля.
 */
import { cookies, headers } from "next/headers";
import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";

const COOKIE_NAME = "finance_session";
const SESSION_TTL_DAYS = 30;

export type SessionUser = { id: string; username: string };

/**
 * Разбор значения x-forwarded-proto в булев флаг Secure.
 *
 * Заголовок может прийти списком («https,http») — левее стоит схема
 * исходного клиента, её и берём. Чего-то отличного от https не считаем
 * безопасным: неизвестная схема безопаснее для входа, чем Secure-cookie,
 * которую браузер на http молча выбросит.
 */
export function isSecureProto(proto: string | null | undefined): boolean {
  if (!proto) return false;
  return proto.split(",")[0]!.trim().toLowerCase() === "https";
}

/**
 * Флаг Secure у cookie сессии — по фактической схеме ТЕКУЩЕГО запроса.
 *
 * Раньше здесь стояло `process.env.NODE_ENV === "production"`, и это ломало
 * вход: `next start` даёт NODE_ENV=production и по http, а браузер
 * Secure-cookie на http не хранит — после входа владелец возвращался на
 * форму логина. NODE_ENV про сборку, а не про то, как владелец открыл
 * приложение.
 *
 * Next.js проставляет x-forwarded-proto сам (base-server): если заголовок
 * пришёл от прокси — берёт его, иначе определяет схему по TLS соединения.
 * Поэтому один этот заголовок покрывает и прямой http/https, и https за
 * обратным прокси.
 */
async function shouldUseSecureCookie(): Promise<boolean> {
  const jar = await headers();
  return isSecureProto(jar.get("x-forwarded-proto"));
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export async function login(username: string, password: string): Promise<SessionUser | null> {
  const user = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  const found = user[0];
  if (!found) return null;
  const ok = await verifyPassword(found.passwordHash, password);
  if (!ok) return null;
  const sid = ulid();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000).toISOString();
  await db.insert(sessions).values({
    id: sid,
    userId: found.id,
    expiresAt,
    createdAt: new Date().toISOString(),
  });
  const jar = await cookies();
  jar.set(COOKIE_NAME, sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: await shouldUseSecureCookie(),
    path: "/",
    expires: new Date(expiresAt),
  });
  return { id: found.id, username: found.username };
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const sid = jar.get(COOKIE_NAME)?.value;
  if (sid) {
    await db.delete(sessions).where(eq(sessions.id, sid));
  }
  jar.delete(COOKIE_NAME);
}

export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const sid = jar.get(COOKIE_NAME)?.value;
  if (!sid) return null;
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sid))
    .limit(1);
  const session = rows[0];
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, sid));
    return null;
  }
  const u = await db
    .select()
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  const user = u[0];
  if (!user) return null;
  return { id: user.id, username: user.username };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new Error("UNAUTHORIZED");
  return user;
}