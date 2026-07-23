import { cookies } from "next/headers";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { revokeDatabaseSession, SESSION_COOKIE_NAME } from "@/modules/access/session-store";

export async function POST(request: Request) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;

  const cookieStore = await cookies();
  await revokeDatabaseSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  cookieStore.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return Response.json({ ok: true });
}
