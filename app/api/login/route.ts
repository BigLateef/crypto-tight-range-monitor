import { NextResponse } from "next/server";
import { COOKIE, SESSION_MAX_AGE, makeSession, passwordOk } from "@/lib/auth";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let pw = "";
  try {
    pw = String((await req.json()).password ?? "");
  } catch {}
  if (!(await passwordOk(pw))) {
    await new Promise((r) => setTimeout(r, 600));
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, await makeSession(), { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_MAX_AGE });
  return res;
}
