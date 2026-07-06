-- ============================================================
-- 顧客削除の対応（2026-07-06）
-- 顧客を削除しても予約履歴は残す（予約側の顧客参照だけ自動で外す）。
-- SQL Editor で実行する。
-- ============================================================

alter table reservations drop constraint reservations_customer_id_fkey;
alter table reservations add constraint reservations_customer_id_fkey
  foreign key (customer_id) references customers (id) on delete set null;
