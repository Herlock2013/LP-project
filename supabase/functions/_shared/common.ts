// 共通処理（全Edge Functionから利用）
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*", // 公開後は独自ドメインに絞る
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

export function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

// ---------- 型 ----------
export interface StoreSettings {
  notification_emails: string[];
  reply_to_email: string | null;
  default_stay_minutes: number;
  group_threshold: number;
  slot_minutes: number;
  cancel_deadline_min: number;
}

export interface CourseRow {
  id: string;
  name: string;
  price: number;
  includes_nomihodai: boolean;
  allow_nomihodai_addon: boolean;
  active: boolean;
}

export interface ReservationRow {
  id: string;
  status: string;
  date: string;
  start_min: number;
  party_size: number;
  course_id: string | null;
  drink_option: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
  notes: string | null;
  cancel_token: string;
}

// ---------- 日付・時刻ヘルパー（JST基準） ----------
export function nowJst(): Date {
  return new Date(Date.now() + 9 * 60 * 60 * 1000); // UTC+9（getUTC系で読む）
}

export function jstToday(): string {
  return nowJst().toISOString().slice(0, 10);
}

// 分表記 → 表示用文字列（1530 → 「25:30（翌1:30）」）
export function minToLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = String(min % 60).padStart(2, "0");
  if (h >= 24) return `${h}:${m}（翌${h - 24}:${m}）`;
  return `${h}:${m}`;
}

export function formatDateJa(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${y}年${m}月${d}日（${["日", "月", "火", "水", "木", "金", "土"][dow]}）`;
}

// ---------- 定型文 ----------
export const GROUP_POLICY_TEXT =
  "※ご来店の1週間前〜2日前の間に5名以上の人数変更がある場合、キャンセル料が発生する可能性があります。人数の変更は都度ご連絡ください。";

export const STORE_NAME = "Dining bar HerLock";
export const STORE_TEL = "0985-35-5414";

// ---------- メール送信（Resend） ----------
interface SendMailInput {
  to: string[];
  subject: string;
  text: string;
  replyTo?: string | null;
}

export async function sendMail(input: SendMailInput): Promise<{ ok: boolean; detail: string }> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("RESEND_FROM"); // 例: "HerLock 予約 <reserve@diningbar-herlock.com>"
  if (!apiKey || !from) return { ok: false, detail: "RESEND_API_KEY / RESEND_FROM 未設定" };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      ...(input.replyTo ? { reply_to: input.replyTo } : {}),
    }),
  });
  const detail = await res.text();
  return { ok: res.ok, detail: res.ok ? "sent" : detail };
}

// ---------- 通知ログ ----------
export async function logNotification(
  db: SupabaseClient,
  reservationId: string | null,
  channel: string,
  ok: boolean,
  detail: string,
): Promise<void> {
  await db.from("notification_log").insert({
    reservation_id: reservationId,
    channel,
    status: ok ? "sent" : "failed",
    detail: detail.slice(0, 500),
  });
}

// ---------- Turnstile（ボット防止）検証 ----------
export async function verifyTurnstile(token: string, ip: string | null): Promise<boolean> {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) return false;
  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  const data = (await res.json()) as { success: boolean };
  return data.success === true;
}
