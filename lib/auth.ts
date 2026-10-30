// Single-password login with an HMAC-signed cookie. Works in middleware (edge) and route handlers.
export const COOKIE = "ctrm_session";
const DAYS = 14;
const enc = new TextEncoder();

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function passwordOk(input: string): Promise<boolean> {
  const secret = process.env.SESSION_SECRET;
  const pw = process.env.APP_PASSWORD;
  if (!secret || !pw) return false;
  return safeEq(await hmacHex(secret, "pw:" + input), await hmacHex(secret, "pw:" + pw));
}
export async function makeSession(): Promise<string> {
  const secret = process.env.SESSION_SECRET || "";
  const exp = Date.now() + DAYS * 86400000;
  return `${exp}.${await hmacHex(secret, "s:" + exp)}`;
}
export async function sessionOk(token: string | undefined): Promise<boolean> {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  return safeEq(sig, await hmacHex(secret, "s:" + exp));
}
export const SESSION_MAX_AGE = DAYS * 86400;
// Accepts the secret as "Authorization: Bearer <secret>" (preferred) or "?cron_secret=<secret>".
// Returns null when OK, otherwise a short reason (safe to show: it never echoes any secret).
export function cronCheck(req: Request): string | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return "CRON_SECRET is not set on the server (add it in Vercel and redeploy)";
  const header = req.headers.get("authorization") || "";
  let query = "";
  try {
    query = new URL(req.url).searchParams.get("cron_secret") || "";
  } catch {}
  if (!header && !query) return "no secret sent (use the Authorization header or ?cron_secret=)";
  if (safeEq(header, `Bearer ${secret}`) || (query && safeEq(query, secret))) return null;
  return "secret does not match the server's CRON_SECRET";
}
