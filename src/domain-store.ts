import type { Ctx } from "./bot.js";

export interface Subscriber {
  chat_id: number;
  opt_in_timestamp: string;
  opt_out_timestamp: string | null;
  language_tag?: string;
  status: "subscribed" | "unsubscribed";
  metadata?: Record<string, string>;
}

export interface Draft {
  draft_id: string;
  created_by_admin_chat_id: number;
  created_at: string;
  message_type: "text" | "image";
  text_content?: string;
  image_file_id?: string;
  caption?: string;
  quick_buttons: string[];
  target_mode: "all" | "custom_list";
  custom_target_list?: number[];
  status: "editing" | "ready" | "sending" | "cancelled";
}

export interface SentBroadcast {
  broadcast_id: string;
  sent_at: string;
  created_by_admin_chat_id: number;
  message_snapshot: Omit<Draft, "draft_id" | "created_by_admin_chat_id" | "created_at" | "status">;
  target_summary: { all_count?: number; custom_count?: number };
  counts_sent: number;
  counts_failed: number;
  counts_unsubscribed_during_send: number;
  failed_examples: string[];
  status: "completed" | "partial" | "aborted";
}

type D1 = { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown>; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }> } } };
type DomainDO = { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string, init?: { method?: string; body?: string }): Promise<Response> } };
type EnvCtx = Ctx & { env?: { DB?: D1; CHAT_DO?: DomainDO } };

export let now = () => new Date();
function db(ctx: EnvCtx): D1 | undefined { return ctx.env?.DB; }
async function exec(ctx: EnvCtx, sql: string, ...values: unknown[]): Promise<void> {
  const d = db(ctx); if (d) await d.prepare(sql).bind(...values).run();
}
async function first<T>(ctx: EnvCtx, sql: string, ...values: unknown[]): Promise<T | undefined> {
  const d = db(ctx); if (!d) return undefined;
  return (await d.prepare(sql).bind(...values).first<T>()) ?? undefined;
}

async function ensure(ctx: EnvCtx): Promise<void> {
  await exec(ctx, "CREATE TABLE IF NOT EXISTS agnt_broadcast_records (kind TEXT NOT NULL, record_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind, record_id))");
}
function domainStub(ctx: EnvCtx) {
  const namespace = ctx.env?.CHAT_DO;
  return namespace ? namespace.get(namespace.idFromName("broadcast-domain")) : undefined;
}
async function put(ctx: EnvCtx, kind: string, id: string, value: unknown): Promise<void> {
  if (!db(ctx)) {
    const stub = domainStub(ctx);
    if (stub) { await stub.fetch("https://do/domain", { method: "PUT", body: JSON.stringify({ key: `${kind}:${id}`, value }) }); return; }
  }
  await ensure(ctx);
  await exec(ctx, "INSERT INTO agnt_broadcast_records(kind,record_id,payload) VALUES(?,?,?) ON CONFLICT(kind,record_id) DO UPDATE SET payload=excluded.payload", kind, id, JSON.stringify(value));
}
async function get<T>(ctx: EnvCtx, kind: string, id: string): Promise<T | undefined> {
  if (!db(ctx)) {
    const stub = domainStub(ctx);
    if (stub) { const response = await stub.fetch(`https://do/domain?key=${encodeURIComponent(`${kind}:${id}`)}`); if (response.status === 200) return (await response.json()) as T; return undefined; }
  }
  await ensure(ctx);
  const row = await first<{ payload: string }>(ctx, "SELECT payload FROM agnt_broadcast_records WHERE kind=? AND record_id=?", kind, id);
  return row ? JSON.parse(row.payload) as T : undefined;
}

export async function saveSubscriber(ctx: EnvCtx, subscriber: Subscriber): Promise<void> {
  await put(ctx, "subscriber", String(subscriber.chat_id), subscriber);
  const index = (await get<number[]>(ctx, "index", "subscribers")) ?? [];
  if (!index.includes(subscriber.chat_id)) { index.push(subscriber.chat_id); await put(ctx, "index", "subscribers", index); }
}
export async function getSubscriber(ctx: EnvCtx, chatId: number): Promise<Subscriber | undefined> { return get<Subscriber>(ctx, "subscriber", String(chatId)); }
export async function subscribedIds(ctx: EnvCtx): Promise<number[]> {
  const ids = (await get<number[]>(ctx, "index", "subscribers")) ?? [];
  const result: number[] = [];
  for (const id of ids) { const s = await getSubscriber(ctx, id); if (s?.status === "subscribed") result.push(id); }
  return result;
}
export async function saveDraft(ctx: EnvCtx, draft: Draft): Promise<void> { await put(ctx, "draft", String(draft.created_by_admin_chat_id), draft); }
export async function getDraft(ctx: EnvCtx, adminId: number): Promise<Draft | undefined> { return get<Draft>(ctx, "draft", String(adminId)); }
export async function saveSent(ctx: EnvCtx, sent: SentBroadcast): Promise<void> {
  await put(ctx, "sent", sent.broadcast_id, sent);
  const index = (await get<string[]>(ctx, "index", "sent")) ?? [];
  if (!index.includes(sent.broadcast_id)) { index.push(sent.broadcast_id); await put(ctx, "index", "sent", index); }
}
export async function listSent(ctx: EnvCtx, adminId: number): Promise<SentBroadcast[]> {
  const ids = (await get<string[]>(ctx, "index", "sent")) ?? [];
  const records: SentBroadcast[] = [];
  for (const id of ids) { const record = await get<SentBroadcast>(ctx, "sent", id); if (record?.created_by_admin_chat_id === adminId) records.push(record); }
  return records.sort((a, b) => b.sent_at.localeCompare(a.sent_at));
}
