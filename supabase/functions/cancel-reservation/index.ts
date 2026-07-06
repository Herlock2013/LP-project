// お客様によるキャンセル API（メール内URLのトークンで本人確認）
// GET  ?token=... … 予約内容の確認（キャンセル画面表示用）
// POST { token }  … キャンセル実行（前日18:00まで）
import {
  adminClient,
  corsHeaders,
  formatDateJa,
  jsonResponse,
  logNotification,
  minToLabel,
  ReservationRow,
  sendMail,
  STORE_NAME,
  STORE_TEL,
  StoreSettings,
} from "../_shared/common.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function deadlineOf(dateStr: string, deadlineMin: number): Date {
  // 来店前日の deadlineMin 分（既定18:00）JST
  const [y, m, d] = dateStr.split("-").map(Number);
  const visit = Date.UTC(y, m - 1, d) - 9 * 3600000; // JSTの0:00をUTCで表現
  return new Date(visit - 24 * 3600000 + deadlineMin * 60000);
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const db = adminClient();
    const token = req.method === "GET"
      ? new URL(req.url).searchParams.get("token") ?? ""
      : ((await req.json()) as { token?: string }).token ?? "";
    if (!UUID_RE.test(token)) return jsonResponse({ error: "無効なURLです。" }, 400);

    const { data } = await db
      .from("reservations")
      .select("id, status, date, start_min, party_size, course_id, drink_option, customer_name, customer_phone, customer_email, notes, cancel_token")
      .eq("cancel_token", token)
      .single();
    const resv = data as ReservationRow | null;
    if (!resv) return jsonResponse({ error: "ご予約が見つかりません。" }, 404);

    const { data: settingsRow } = await db.from("settings").select("*").eq("id", 1).single();
    const settings = settingsRow as StoreSettings;
    const deadline = deadlineOf(resv.date, settings.cancel_deadline_min);
    const cancellable = ["pending", "confirmed"].includes(resv.status) && new Date() < deadline;

    const summary = {
      date_label: formatDateJa(resv.date),
      time_label: `${minToLabel(resv.start_min)}〜`,
      party_size: resv.party_size,
      name: resv.customer_name,
      status: resv.status,
      cancellable,
    };

    if (req.method === "GET") return jsonResponse({ reservation: summary });

    // ---- POST: キャンセル実行 ----
    if (resv.status === "cancelled") return jsonResponse({ error: "このご予約はすでにキャンセル済みです。" }, 409);
    if (!["pending", "confirmed"].includes(resv.status)) return jsonResponse({ error: "このご予約はキャンセルできません。" }, 409);
    if (new Date() >= deadline) {
      return jsonResponse({ error: `Webでのキャンセルは前日18:00までです。恐れ入りますがお電話（${STORE_TEL}）にてご連絡ください。` }, 409);
    }

    const { error: updError } = await db
      .from("reservations")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", resv.id)
      .in("status", ["pending", "confirmed"]);
    if (updError) return jsonResponse({ error: "キャンセル処理に失敗しました。お電話にてご連絡ください。" }, 500);

    await db.from("audit_log").insert({
      actor: "customer",
      action: "cancel_via_web",
      target_id: resv.id,
      detail: { token_used: true },
    });

    const dateLabel = `${formatDateJa(resv.date)} ${minToLabel(resv.start_min)}〜 ${resv.party_size}名様`;

    if (resv.customer_email) {
      const mail = await sendMail({
        to: [resv.customer_email],
        subject: `【${STORE_NAME}】キャンセル手続き完了のお知らせ`,
        text: `${resv.customer_name} 様\n\n以下のご予約のキャンセルを承りました。\n\n${dateLabel}\n\nまたのご利用を心よりお待ちしております。\n\n${STORE_NAME}\nTEL: ${STORE_TEL}`,
        replyTo: settings.reply_to_email,
      });
      await logNotification(db, resv.id, "email_customer", mail.ok, mail.detail);
    }

    if (settings.notification_emails.length > 0) {
      const mail = await sendMail({
        to: settings.notification_emails,
        subject: `【キャンセル】${dateLabel}`,
        text: `お客様がWebからキャンセルしました。\n\n${dateLabel}\nお名前: ${resv.customer_name}\n電話: ${resv.customer_phone}`,
      });
      await logNotification(db, resv.id, "email_store", mail.ok, mail.detail);
    }

    return jsonResponse({ ok: true, message: "キャンセルを承りました。確認メールをお送りしました。" });
  } catch (e) {
    console.error("cancel-reservation unexpected:", e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: "予期しないエラーが発生しました。お電話にてご連絡ください。" }, 500);
  }
});
