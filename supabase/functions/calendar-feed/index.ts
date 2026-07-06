// カレンダー購読フィード（ICS形式）
// Outlook / iPhone / Google カレンダーから「URLで購読」するだけで予約一覧が見られる。
// URLを知っている人だけがアクセスできるよう、鍵付き: ?key=CALENDAR_FEED_KEY
// デプロイ: supabase functions deploy calendar-feed --no-verify-jwt
import { adminClient, minToLabel } from "../_shared/common.ts";

interface FeedRow {
  id: string;
  status: string;
  date: string;
  start_min: number;
  party_size: number;
  customer_name: string;
  customer_phone: string;
  source: string;
  notes: string | null;
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function icsDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const key = Deno.env.get("CALENDAR_FEED_KEY");
  if (!key || url.searchParams.get("key") !== key) {
    return new Response("not found", { status: 404 });
  }

  const db = adminClient();
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const until = new Date(Date.now() + 9 * 3600000 + 60 * 24 * 3600000).toISOString().slice(0, 10);

  const { data } = await db
    .from("reservations")
    .select("id, status, date, start_min, party_size, customer_name, customer_phone, source, notes")
    .gte("date", today)
    .lte("date", until)
    .in("status", ["pending", "confirmed", "seated"])
    .order("date")
    .order("start_min");
  const rows = (data as FeedRow[]) ?? [];

  const { data: settingsRow } = await db.from("settings").select("default_stay_minutes").eq("id", 1).single();
  const stay = (settingsRow as { default_stay_minutes: number } | null)?.default_stay_minutes ?? 120;

  const srcJa: Record<string, string> = { web: "Web", hotpepper: "HP", phone: "電話", walkin: "来店" };
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HerLock//Reservations//JP",
    "X-WR-CALNAME:HerLock予約",
    "X-WR-TIMEZONE:Asia/Tokyo",
  ];
  const now = icsDate(Date.now());
  for (const r of rows) {
    const startMs = Date.parse(`${r.date}T00:00:00+09:00`) + r.start_min * 60000;
    const summary = `${r.status === "pending" ? "【仮】" : ""}${minToLabel(r.start_min)} ${r.customer_name}様 ${r.party_size}名`;
    const desc = `TEL: ${r.customer_phone}\n受付: ${srcJa[r.source] ?? r.source}${r.notes ? `\nメモ: ${r.notes}` : ""}`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${r.id}@herlock-reservation`,
      `DTSTAMP:${now}`,
      `DTSTART:${icsDate(startMs)}`,
      `DTEND:${icsDate(startMs + stay * 60000)}`,
      `SUMMARY:${icsEscape(summary)}`,
      `DESCRIPTION:${icsEscape(desc)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");

  return new Response(lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
});
