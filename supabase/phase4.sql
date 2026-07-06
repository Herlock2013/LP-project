-- ============================================================
-- Phase 4: LINE通知・Googleカレンダー連携
-- SQL Editor で実行する
-- ============================================================

-- Googleカレンダーの予定IDを保持（キャンセル時に予定を消すため）
alter table reservations add column if not exists google_event_id text;
