-- ============================================================
-- 席管理の簡素化（2026-07-06 店の運用に合わせた変更）
-- 1Fを「カウンター」「テーブル・個室」の2枠（人数プール）にする。
-- 個室のどこに通すかは当日スタッフが調整する運用。
-- admin-policies.sql 実行後に SQL Editor で実行する。
-- ============================================================

-- 既存の1F席種を無効化（過去の予約データはそのまま残る）
update seat_types set active = false where floor = 1;

-- 新しい2枠を追加
insert into seat_types (name, floor, exclusive, total_capacity, min_party, max_party, sort) values
  ('カウンター',     1, false, 8,  1, 8,  1),
  ('テーブル・個室', 1, false, 34, 1, 15, 2);
  -- 34 = 完全個室8 + 半個室A5 + 半個室B4 + 半個室C7 + テーブル10（数が違えばここを修正）

-- 確認用: 有効な席種の一覧
select name, floor, total_capacity, min_party, max_party
from seat_types where active order by floor, sort;
