import { sql } from "./db";
import { DEFAULTS, validateSettings, type Settings } from "./config";

export async function loadSettings(): Promise<Settings> {
  const rows = await sql()`select data from app_settings where id = 1`;
  const stored = rows[0]?.data && typeof rows[0].data === "object" ? rows[0].data : {};
  return validateSettings(stored, DEFAULTS).settings; // invalid stored fields fall back to defaults
}

export async function saveSettings(patch: Record<string, unknown>) {
  const cur = await loadSettings();
  const r = validateSettings(patch, cur);
  if (!r.ok) return r;
  await sql()`update app_settings set data = ${JSON.stringify(r.settings)}::jsonb, updated_at = now() where id = 1`;
  const back = await loadSettings(); // read it straight back: a save that did not stick must not look successful
  if (JSON.stringify(back) !== JSON.stringify(r.settings)) {
    return { settings: back, errors: ["Saved, but the database returned different values. Reload and check Settings before relying on them."], ok: false as const };
  }
  return r;
}
