export async function api<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, cache: "no-store", headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.href = "/login";
    throw new Error("Signed out");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e: any = new Error(body?.errors?.join("; ") || body?.error || `Request failed (${res.status})`);
    e.body = body;
    throw e;
  }
  return body as T;
}
