// 予約作成 API
// POST { date, start_min, party_size, course_id, drink_option, name, phone, email, notes, turnstile_token }
import {
  adminClient,
  corsHeaders,
  CourseRow,
  formatDateJa,
  GROUP_POLICY_TEXT,
  jsonResponse,
  logNotification,
  minToLabel,
  sendMail,
  STORE_NAME,
  STORE_TEL,
  StoreSettings,
  verifyTurnstile,
} from "../_shared/common.ts";
import { gcalInsert, linePush } from "../_shared/notify.ts";

interface CreateBody {
  date: string;
  start_min: number;
  party_size: number;
  course_id: string | null;
  drink_option: string;
  name: string;
  phone: string;
  email: string;
  notes: string;
  turnstile_token: string;
}

interface RpcResult {
  id: string;
  status: string;
  cancel_token: string;
  date: string;
  start_min: number;
  party_size: number;
}

const ERROR_MESSAGES: Record<string, string> = {
  DAY_CLOSED: "申し訳ございません。選択された日は休業日です。",
  OUT_OF_HOURS: "選択された時間は営業時間外です。",
  DEADLINE_PASSED: "Web予約の受付は前日までとなっております。当日のご予約はお電話ください。",
  FULL: "申し訳ございません。選択された時間は満席です。別の時間をお試しください。",
};

function validate(b: CreateBody): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return "日付の形式が正しくありません。";
  if (!Number.isInteger(b.start_min) || b.start_min < 0 || b.start_min > 1800) return "時間の指定が正しくありません。";
  if (!Number.isInteger(b.party_size) || b.party_size < 1 || b.party_size > 200) return "人数の指定が正しくありません。";
  if (!b.name || b.name.trim().length === 0 || b.name.length > 50) return "お名前をご入力ください（50文字以内）。";
  if (!/^0\d{9,10}$/.test(b.phone.replace(/[-\s]/g, ""))) return "電話番号の形式が正しくありません。";
  if (!b.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) || b.email.length > 100) return "メールアドレスの形式が正しくありません。";
  if (b.notes && b.notes.length > 500) return "ご要望は500文字以内でご入力ください。";
  if (!["none", "included", "add_1500", "standalone_3500"].includes(b.drink_option)) return "飲み放題の選択が正しくありません。";
  return null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  try {
    const body = (await req.json()) as CreateBody;
    const clientIp = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for");

    // 1. 入力チェック
    const invalid = validate(body);
    if (invalid) return jsonResponse({ error: invalid }, 400);

    // 2. ボット防止（Turnstile）
    const human = await verifyTurnstile(body.turnstile_token ?? "", clientIp);
    if (!human) return jsonResponse({ error: "認証に失敗しました。ページを再読み込みしてお試しください。" }, 400);

    const db = adminClient();
    const phone = body.phone.replace(/[-\s]/g, "");

    // 3. 連続予約の制限（同一電話番号: 直近10分で3件まで）
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { count } = await db
      .from("reservations")
      .select("id", { count: "exact", head: true })
      .eq("customer_phone", phone)
      .gte("created_at", tenMinAgo);
    if ((count ?? 0) >= 3) {
      return jsonResponse({ error: "短時間に複数のご予約はできません。しばらくしてからお試しください。" }, 429);
    }

    // 4. コースと飲み放題の整合性チェック
    let course: CourseRow | null = null;
    if (body.course_id) {
      const { data } = await db.from("courses").select("*").eq("id", body.course_id).eq("active", true).single();
      course = data as CourseRow | null;
      if (!course) return jsonResponse({ error: "選択されたコースが見つかりません。" }, 400);
    }
    const opt = body.drink_option;
    if (course && course.includes_nomihodai && opt !== "included") return jsonResponse({ error: "このコースは飲み放題込みです。" }, 400);
    if (course && !course.includes_nomihodai && opt === "included") return jsonResponse({ error: "飲み放題の選択が正しくありません。" }, 400);
    if (course && opt === "add_1500" && !course.allow_nomihodai_addon) return jsonResponse({ error: "このコースには飲み放題を追加できません。" }, 400);
    if (course && opt === "standalone_3500") return jsonResponse({ error: "単品飲み放題は席のみ予約でご利用いただけます。" }, 400);
    if (!course && (opt === "included" || opt === "add_1500")) return jsonResponse({ error: "飲み放題の選択が正しくありません。" }, 400);

    // 5. 予約作成（DB側で残席再チェック＋受付期限チェック）
    const { data: rpcData, error: rpcError } = await db.rpc("fn_create_reservation", {
      p_date: body.date,
      p_start_min: body.start_min,
      p_party: body.party_size,
      p_course_id: body.course_id,
      p_drink_option: opt,
      p_name: body.name.trim(),
      p_phone: phone,
      p_email: body.email.trim(),
      p_notes: (body.notes ?? "").trim(),
    });

    if (rpcError) {
      const key = Object.keys(ERROR_MESSAGES).find((k) => rpcError.message.includes(k));
      if (key) return jsonResponse({ error: ERROR_MESSAGES[key] }, 409);
      console.error("fn_create_reservation error:", rpcError.message);
      return jsonResponse({ error: "予約処理でエラーが発生しました。お電話にてご予約ください。" }, 500);
    }
    const result = rpcData as RpcResult;
    const isGroup = result.status === "pending";

    // 6. メール送信
    const { data: settingsRow } = await db.from("settings").select("*").eq("id", 1).single();
    const settings = settingsRow as StoreSettings;
    const dateLabel = `${formatDateJa(result.date)} ${minToLabel(result.start_min)}〜`;
    const courseLabel = course ? `${course.name}（${course.price.toLocaleString()}円）` : "席のみ";
    const drinkLabel = { none: "なし", included: "コースに含む", add_1500: "飲み放題追加（+1,500円）", standalone_3500: "単品飲み放題プラン（+3,500円）" }[opt] ?? "なし";
    const cancelUrl = `${Deno.env.get("SITE_URL") ?? "https://diningbar-herlock.com"}/reserve.html?cancel=${result.cancel_token}`;

    const detailBlock = [
      `日時: ${dateLabel}`,
      `人数: ${result.party_size}名様`,
      `コース: ${courseLabel}`,
      `飲み放題: ${drinkLabel}`,
      body.notes ? `ご要望: ${body.notes}` : null,
    ].filter((v) => v !== null).join("\n");

    const customerText = isGroup
      ? `${body.name} 様\n\nこの度は${STORE_NAME}にご予約のお申し込みをいただき、誠にありがとうございます。\n団体でのご予約のため、内容確認のお電話を店舗より差し上げます。\n恐れ入りますが、お電話をもってご予約確定となります。\n\n【お申し込み内容（仮受付）】\n${detailBlock}\n\n${GROUP_POLICY_TEXT}\n\n${STORE_NAME}\nTEL: ${STORE_TEL}`
      : `${body.name} 様\n\nこの度は${STORE_NAME}にご予約いただき、誠にありがとうございます。\n以下の内容でご予約を承りました。\n\n【ご予約内容】\n${detailBlock}\n\nキャンセルは前日18:00まで、下記URLより承ります。\n${cancelUrl}\nそれ以降のご変更・キャンセルはお電話にてご連絡ください。\n\n${STORE_NAME}\nTEL: ${STORE_TEL}`;

    const customerMail = await sendMail({
      to: [body.email.trim()],
      subject: isGroup ? `【${STORE_NAME}】ご予約仮受付のお知らせ（店舗よりお電話いたします）` : `【${STORE_NAME}】ご予約確認`,
      text: customerText,
      replyTo: settings.reply_to_email,
    });
    await logNotification(db, result.id, "email_customer", customerMail.ok, customerMail.detail);

    if (settings.notification_emails.length > 0) {
      const storeMail = await sendMail({
        to: settings.notification_emails,
        subject: isGroup
          ? `【要電話確認】団体予約 ${result.party_size}名 ${dateLabel}`
          : `【新規予約】${result.party_size}名 ${dateLabel}`,
        text: `${isGroup ? "★団体の仮受付です。お客様へ確認のお電話をお願いします。\n\n" : ""}${detailBlock}\nお名前: ${body.name}\n電話: ${phone}\nメール: ${body.email}`,
      });
      await logNotification(db, result.id, "email_store", storeMail.ok, storeMail.detail);
    }

    // 7. LINE通知（店長）＋ Googleカレンダー登録（未設定ならスキップ）
    await linePush(db, result.id,
      (isGroup ? "【要電話確認・団体】\n" : "【新規予約】\n") +
      `${dateLabel}\n${result.party_size}名 ${body.name} 様\nTEL ${phone}\n${courseLabel} / 飲み放題: ${drinkLabel}` +
      (body.notes ? `\nメモ: ${body.notes}` : ""));

    const eventId = await gcalInsert(db, result.id, {
      date: result.date,
      startMin: result.start_min,
      stayMinutes: settings.default_stay_minutes,
      summary: `${isGroup ? "【仮】" : ""}${minToLabel(result.start_min)} ${body.name}様 ${result.party_size}名`,
      description: `TEL: ${phone}\n${courseLabel} / 飲み放題: ${drinkLabel}\n受付: Web${body.notes ? `\nメモ: ${body.notes}` : ""}`,
    });
    if (eventId) {
      await db.from("reservations").update({ google_event_id: eventId }).eq("id", result.id);
    }

    return jsonResponse({
      ok: true,
      status: result.status,
      message: isGroup
        ? "仮受付を承りました。内容確認のため、店舗よりお電話いたします。"
        : "ご予約を承りました。確認メールをお送りしましたのでご確認ください。",
    });
  } catch (e) {
    console.error("create-reservation unexpected:", e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: "予期しないエラーが発生しました。お電話にてご予約ください。" }, 500);
  }
});
