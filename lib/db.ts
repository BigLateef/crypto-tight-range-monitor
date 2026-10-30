// One tagged-template `sql` for both supported databases, chosen from DATABASE_URL:
//  - Neon (host contains "neon.tech"): Neon's HTTP driver
//  - anything else (e.g. Supabase): a standard Postgres driver. For Supabase use the TRANSACTION POOLER url (port 6543).
import { neon } from "@neondatabase/serverless";
import postgres from "postgres";

export type Row = Record<string, any>;
export type Sql = (strings: TemplateStringsArray, ...values: any[]) => Promise<Row[]>;

let pg: any = null;
let cached: Sql | null = null;

export function sql(): Sql {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (/neon\.tech/i.test(url)) {
    cached = neon(url, { fetchOptions: { cache: "no-store" } }) as unknown as Sql;
  } else {
    // prepare:false is required behind Supabase's transaction pooler; max:1 suits serverless functions
    pg = postgres(url, { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 10, ssl: "require" });
    cached = ((strings: TemplateStringsArray, ...values: any[]) => pg(strings, ...values)) as unknown as Sql;
  }
  return cached;
}
