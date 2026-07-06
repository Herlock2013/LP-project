// LINE Webhook（店長のユーザーID取得用）
// LINE Developers コンソールの Webhook URL にこの関数のURLを設定し、
// 店長が公式アカウントへメッセージを送ると userId が audit_log に記録される。
// デプロイ: supabase functions deploy line-webhook --no-verify-jwt
import { adminClient, jsonResponse } from "../_shared/common.ts";

interface LineEvent {
  type: string;
  source?: { type: string; userId?: string };
}

async function validSignature(body: string, signature: string | null): Promise<boolean> {
  const secret = Deno.env.get("LINE_CHANNEL_SECRET");
  if (!secret) return true; // シークレット未設定時は検証スキップ（設定推奨）
  if (!signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  let bin = "";
  for (const b of mac) bin += String.fromCharCode(b);
  return btoa(bin) === signature;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return jsonResponse({ ok: true });
  try {
    const body = await req.text();
    if (!(await validSignature(body, req.headers.get("x-line-signature")))) {
      return jsonResponse({ error: "bad signature" }, 403);
    }
    const payload = JSON.parse(body) as { events?: LineEvent[] };
    const db = adminClient();
    for (const ev of payload.events ?? []) {
      const userId = ev.source?.userId;
      if (userId) {
        await db.from("audit_log").insert({
          actor: "line-webhook",
          action: "line_user_capture",
          detail: { userId, event_type: ev.type },
        });
      }
    }
    return jsonResponse({ ok: true });
  } catch (e) {
    console.error("line-webhook error:", e instanceof Error ? e.message : String(e));
    return jsonResponse({ ok: true }); // LINE側の再送を避けるため常に200
  }
});
