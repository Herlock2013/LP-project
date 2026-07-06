-- ============================================================
-- 予約履歴の削除対応（2026-07-06）
-- キャンセル・無断・済の予約のみスタッフが削除できるようにする。
-- 送信ログの参照も自動で外す。SQL Editor で実行する。
-- ============================================================

-- 送信ログが予約を参照していても削除できるように（ログ自体は残る）
alter table notification_log drop constraint notification_log_reservation_id_fkey;
alter table notification_log add constraint notification_log_reservation_id_fkey
  foreign key (reservation_id) references reservations (id) on delete set null;

-- 終了状態の予約のみ削除可（有効な予約はDBレベルで削除不可）
create policy staff_delete_reservations on reservations
  for delete to authenticated
  using (status in ('cancelled', 'noshow', 'finished'));
