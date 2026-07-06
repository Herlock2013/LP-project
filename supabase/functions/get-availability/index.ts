// 空き状況・フォーム表示用データの取得 API（読み取り専用・個人情報は一切返さない）
// GET ?mode=meta                     … コース一覧・設定（フォーム初期表示用）
// GET ?mode=calendar&from=Y-M-D&to=Y-M-D … 営業/休業カレンダー
// GET ?mode=slots&date=Y-M-D&party=N … 指定日の予約可能時間一覧
import { adminClient, corsHeaders, jsonResponse, jstToday, StoreSettings } from "../_shared/common.ts";

interface CalendarDay {
  date: string;
  is_open: boolean;
}

interface SlotRow {
  start_min: number;
  available: boolean;
}

function isDateStr(v: string | null): v is string {
  return v !== null && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return jsonResponse({ error: "method not allowed" }, 405);

  try {
    const url = new URL(req.url);
    const mode = url.searchParams.get("mode");
    const db = adminClient();

    if (mode === "meta") {
      const { data: courses } = await db
        .from("courses")
        .select("id, name, price, includes_nomihodai, allow_nomihodai_addon")
        .eq("active", true)
        .order("sort");
      const { data: settingsRow } = await db
        .from("settings")
        .select("group_threshold, slot_minutes")
        .eq("id", 1)
        .single();
      const settings = settingsRow as Pick<StoreSettings, "group_threshold" | "slot_minutes">;
      return jsonResponse({ courses: courses ?? [], settings });
    }

    if (mode === "calendar") {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (!isDateStr(from) || !isDateStr(to)) return jsonResponse({ error: "invalid range" }, 400);
      // 過去日は不可・最大90日先まで表示
      const { data, error } = await db.rpc("fn_calendar", { p_from: from, p_to: to });
      if (error) return jsonResponse({ error: "calendar error" }, 500);
      const today = jstToday();
      const days = (data as CalendarDay[]).map((d) => ({
        date: d.date,
        // 当日予約はWeb不可のため、今日以前は選択不可として返す
        is_open: d.is_open && d.date > today,
      }));
      return jsonResponse({ days });
    }

    if (mode === "slots") {
      const date = url.searchParams.get("date");
      const party = Number(url.searchParams.get("party"));
      if (!isDateStr(date) || !Number.isInteger(party) || party < 1 || party > 200) {
        return jsonResponse({ error: "invalid params" }, 400);
      }
      if (date <= jstToday()) return jsonResponse({ slots: [] }); // 当日以前は電話のみ
      const { data, error } = await db.rpc("fn_day_slots", { p_date: date, p_party: party });
      if (error) return jsonResponse({ error: "slots error" }, 500);
      return jsonResponse({ slots: (data as SlotRow[]) ?? [] });
    }

    return jsonResponse({ error: "unknown mode" }, 400);
  } catch (e) {
    console.error("get-availability unexpected:", e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: "server error" }, 500);
  }
});
