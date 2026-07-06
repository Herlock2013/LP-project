// 前日リマインドメール送信（スケジュール実行: 毎日 JST 10:00 を想定）
// Supabase ダッシュボードの Cron から呼び出す（セットアップ手順書参照）
import {
  adminClient,
  formatDateJa,
  jsonResponse,
  logNotification,
  minToLabel,
  nowJst,
  ReservationRow,
  sendMail,
  STORE_NAME,
  STORE_TEL,
  StoreSettings,
} from "../_shared/common.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  // Cron からの呼び出しのみ許可（共有シークレットで確認）
  const auth = req.headers.get("authorization") ?? "";
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  try {
    const db = adminClient();

    // 明日（JST）の有効な予約を取得
    const tomorrow = new Date(nowJst().getTime() + 24 * 3600000).toISOString().slice(0, 10);
    const { data } = await db
      .from("reservations")
      .select("id, status, date, start_min, party_size, course_id, drink_option, customer_name, customer_phone, customer_email, notes, cancel_token")
      .eq("date", tomorrow)
      .in("status", ["pending", "confirmed"]);
    const targets = (data as ReservationRow[]) ?? [];

    const { data: settingsRow } = await db.from("settings").select("*").eq("id", 1).single();
    const settings = settingsRow as StoreSettings;

    let sent = 0;
    for (const r of targets) {
      if (!r.customer_email) continue;

      // 送信済みならスキップ（多重送信防止）
      const { count } = await db
        .from("notification_log")
        .select("id", { count: "exact", head: true })
        .eq("reservation_id", r.id)
        .eq("channel", "reminder")
        .eq("status", "sent");
      if ((count ?? 0) > 0) continue;

      const mail = await sendMail({
        to: [r.customer_email],
        subject: `【${STORE_NAME}】明日のご予約のご確認`,
        text:
          `${r.customer_name} 様\n\n明日のご予約のご確認です。ご来店を心よりお待ちしております。\n\n` +
          `日時: ${formatDateJa(r.date)} ${minToLabel(r.start_min)}〜\n人数: ${r.party_size}名様\n\n` +
          `ご変更・キャンセルはお電話（${STORE_TEL}）にてご連絡ください。\n\n${STORE_NAME}`,
        replyTo: settings.reply_to_email,
      });
      await logNotification(db, r.id, "reminder", mail.ok, mail.detail);
      if (mail.ok) sent += 1;
    }

    return jsonResponse({ ok: true, date: tomorrow, targets: targets.length, sent });
  } catch (e) {
    console.error("send-reminders unexpected:", e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: "server error" }, 500);
  }
});
