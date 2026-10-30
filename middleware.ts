import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, sessionOk } from "@/lib/auth";

export async function middleware(req: NextRequest) {
  if (await sessionOk(req.cookies.get(COOKIE)?.value)) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

// /login, /api/login and /api/tick (cron secret) are public; everything else needs the session.
export const config = { matcher: ["/((?!_next/|favicon|login|api/login|api/tick).*)"] };
