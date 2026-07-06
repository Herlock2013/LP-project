-- ============================================================
-- Phase 3: スタッフ（ログイン済みユーザー）用のRLSポリシー
-- Supabase の SQL Editor で schema.sql 実行後に実行する
--
-- 前提: スタッフアカウントは Supabase ダッシュボードから手動作成し、
--       新規サインアップは無効化しておくこと（手順書参照）。
--       これにより authenticated = スタッフ本人のみとなる。
-- ============================================================

-- 予約: 閲覧・登録（HP/電話予約の手動登録）・更新（確定/着席/キャンセル等）
create policy staff_select_reservations on reservations
  for select to authenticated using (true);
create policy staff_insert_reservations on reservations
  for insert to authenticated with check (source in ('hotpepper', 'phone', 'walkin'));
create policy staff_update_reservations on reservations
  for update to authenticated using (true);
-- 削除は不可（記録を残すため。取り消しは status=cancelled で行う）

-- 顧客リスト: 閲覧・編集・削除（削除依頼対応）
create policy staff_select_customers on customers
  for select to authenticated using (true);
create policy staff_insert_customers on customers
  for insert to authenticated with check (true);
create policy staff_update_customers on customers
  for update to authenticated using (true);
create policy staff_delete_customers on customers
  for delete to authenticated using (true);

-- マスタ類: 閲覧
create policy staff_select_seat_types on seat_types
  for select to authenticated using (true);
create policy staff_select_courses on courses
  for select to authenticated using (true);
create policy staff_select_schedule on schedule_rules
  for select to authenticated using (true);

-- 営業日カレンダー: 閲覧・登録・変更・削除（不定休の設定）
create policy staff_all_special_days on special_days
  for all to authenticated using (true) with check (true);

-- 店舗設定: 閲覧・変更（通知先メール等）
create policy staff_select_settings on settings
  for select to authenticated using (true);
create policy staff_update_settings on settings
  for update to authenticated using (true);

-- ログ: 閲覧＋監査ログ追記
create policy staff_select_notification_log on notification_log
  for select to authenticated using (true);
create policy staff_insert_audit_log on audit_log
  for insert to authenticated with check (true);
create policy staff_select_audit_log on audit_log
  for select to authenticated using (true);
