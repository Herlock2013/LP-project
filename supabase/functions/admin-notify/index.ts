// スタッフ操作時のお客様向けメール送信 API（要ログイン）
// POST { reservation_id, type: "confirmed" | "cancelled" }
// デプロイは JWT 検証あり（--no-verify-jwt を付けない）
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  adminClient,
  corsHeaders,
  formatDateJa,
  GROUP_POLICY_TEXT,
  jsonResponse,
  logNotification,
  minToLabel,
  ReservationRow,
  sendMail,
  STORE_NAME,
  STORE_TEL,
  StoreSettings,
} from "../_shared/common.ts";

interface NotifyBody {
  reservation_id: string;
  type: "confirmed" | "cancelled";
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  try {
    // ログイン済みスタッフか検証
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    const authClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    );
    const { data: userData, error: userError } = await authClient.auth.getUser(jwt);
    if (userError || !userData.user) return jsonResponse({ error: "unauthorized" }, 401);
    const staffEmail = userData.user.email ?? "staff";

    const body = (await req.json()) as NotifyBody;
    if (!body.reservation_id || !["confirmed", "cancelled"].includes(body.type)) {
      return jsonResponse({ error: "invalid params" }, 400);
    }

    const db = adminClient();
    const { data } = await db
      .from("reservations")
      .select("id, status, date, start_min, party_size, course_id, drink_option, customer_name, customer_phone, customer_email, notes, cancel_token")
      .eq("id", body.reservation_id)
      .single();
    const resv = data as ReservationRow | null;
    if (!resv) return jsonResponse({ error: "reservation not found" }, 404);
    if (!resv.customer_email) return jsonResponse({ ok: true, skipped: "メールアドレスなしのため送信なし" });

    const { data: settingsRow } = await db.from("settings").select("*").eq("id", 1).single();
    const settings = settingsRow as StoreSettings;
    const dateLabel = `${formatDateJa(resv.date)} ${minToLabel(resv.start_min)}〜`;
    const cancelUrl = `${Deno.env.get("SITE_URL") ?? "https://diningbar-herlock.com"}/reserve.html?cancel=${resv.cancel_token}`;
    const isGroup = resv.party_size >= settings.group_threshold;

    const text = body.type === "confirmed"
      ? `${resv.customer_name} 様\n\nお電話ありがとうございました。以下の内容でご予約が確定いたしました。\n\n【ご予約内容】\n日時: ${dateLabel}\n人数: ${resv.party_size}名様\n\n${isGroup ? GROUP_POLICY_TEXT + "\n\n" : ""}キャンセルは前日18:00まで、下記URLより承ります。\n${cancelUrl}\nそれ以降のご変更・キャンセルはお電話にてご連絡ください。\n\n${STORE_NAME}\nTEL: ${STORE_TEL}`
      : `${resv.customer_name} 様\n\n以下のご予約のキャンセルを承りました。\n\n日時: ${dateLabel}\n人数: ${resv.party_size}名様\n\nまたのご利用を心よりお待ちしております。\n\n${STORE_NAME}\nTEL: ${STORE_TEL}`;

    const mail = await sendMail({
      to: [resv.customer_email],
      subject: body.type === "confirmed"
        ? `【${STORE_NAME}】ご予約確定のお知らせ`
        : `【${STORE_NAME}】キャンセル手続き完了のお知らせ`,
      text,
      replyTo: settings.reply_to_email,
    });
    await logNotification(db, resv.id, "email_customer", mail.ok, mail.detail);
    await db.from("audit_log").insert({
      actor: staffEmail,
      action: `notify_${body.type}`,
      target_id: resv.id,
      detail: { sent: mail.ok },
    });

    return jsonResponse({ ok: mail.ok, error: mail.ok ? undefined : "メール送信に失敗しました" });
  } catch (e) {
    console.error("admin-notify unexpected:", e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: "server error" }, 500);
  }
});
