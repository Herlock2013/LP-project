// LINE通知・Googleカレンダー連携ヘルパー
// 必要な環境変数が未設定の場合は何もせずスキップする（メール等の主要機能は止めない）
import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { logNotification } from "./common.ts";

// ---------- LINE（店長1人へpush） ----------
export async function linePush(db: SupabaseClient, reservationId: string | null, text: string): Promise<void> {
  const token = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
  const to = Deno.env.get("LINE_TO");
  if (!token || !to) return;
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
    });
    await logNotification(db, reservationId, "line", res.ok, res.ok ? "sent" : await res.text());
  } catch (e) {
    await logNotification(db, reservationId, "line", false, e instanceof Error ? e.message : String(e));
  }
}

// ---------- Google Calendar（サービスアカウント認証） ----------
let cachedToken: { token: string; exp: number } | null = null;

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function googleToken(): Promise<string | null> {
  const email = Deno.env.get("GOOGLE_SA_EMAIL");
  const keyPem = Deno.env.get("GOOGLE_SA_PRIVATE_KEY");
  if (!email || !keyPem) return null;
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp > now + 60) return cachedToken.token;

  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = b64url(enc.encode(JSON.stringify({
    iss: email,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })));
  const input = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToDer(keyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(input)));
  const jwt = `${input}.${b64url(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  if (!res.ok) {
    console.error("google token error:", await res.text());
    return null;
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, exp: now + data.expires_in };
  return data.access_token;
}

function calBase(): string | null {
  const calId = Deno.env.get("GOOGLE_CALENDAR_ID");
  return calId ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events` : null;
}

export interface CalEventInput {
  date: string;       // 営業日
  startMin: number;   // 営業日0:00からの分
  stayMinutes: number;
  summary: string;
  description: string;
}

export async function gcalInsert(db: SupabaseClient, reservationId: string, ev: CalEventInput): Promise<string | null> {
  const token = await googleToken();
  const base = calBase();
  if (!token || !base) return null;
  try {
    const startMs = Date.parse(`${ev.date}T00:00:00+09:00`) + ev.startMin * 60000;
    const res = await fetch(base, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: ev.summary,
        description: ev.description,
        start: { dateTime: new Date(startMs).toISOString() },
        end: { dateTime: new Date(startMs + ev.stayMinutes * 60000).toISOString() },
      }),
    });
    const ok = res.ok;
    const body = await res.text();
    await logNotification(db, reservationId, "gcal", ok, ok ? "created" : body);
    if (!ok) return null;
    return (JSON.parse(body) as { id: string }).id;
  } catch (e) {
    await logNotification(db, reservationId, "gcal", false, e instanceof Error ? e.message : String(e));
    return null;
  }
}

export async function gcalPatchSummary(db: SupabaseClient, reservationId: string, eventId: string, summary: string): Promise<void> {
  const token = await googleToken();
  const base = calBase();
  if (!token || !base) return;
  try {
    const res = await fetch(`${base}/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ summary }),
    });
    await logNotification(db, reservationId, "gcal", res.ok, res.ok ? "patched" : await res.text());
  } catch (e) {
    await logNotification(db, reservationId, "gcal", false, e instanceof Error ? e.message : String(e));
  }
}

export async function gcalDelete(db: SupabaseClient, reservationId: string, eventId: string): Promise<void> {
  const token = await googleToken();
  const base = calBase();
  if (!token || !base) return;
  try {
    const res = await fetch(`${base}/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    const ok = res.ok || res.status === 404 || res.status === 410;
    await logNotification(db, reservationId, "gcal", ok, ok ? "deleted" : await res.text());
  } catch (e) {
    await logNotification(db, reservationId, "gcal", false, e instanceof Error ? e.message : String(e));
  }
}
