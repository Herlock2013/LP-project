-- ============================================================
-- HerLock 予約システム DBスキーマ（設計書 v1.3 準拠）
-- Supabase の SQL Editor にそのまま貼り付けて実行する
-- 時刻は「営業日の0:00からの経過分」で保持する（例: 18:00=1080, 25:30=1530）
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- 席種 ----------
create table seat_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  floor int not null default 1,
  -- true = 個室型（1組で貸切） / false = 相席型（定員を人数で共有）
  exclusive boolean not null default false,
  total_capacity int not null check (total_capacity > 0),
  min_party int not null default 1,
  max_party int not null,
  active boolean not null default true,
  sort int not null default 0
);

-- ---------- 営業スケジュール（曜日ごとの既定値） ----------
create table schedule_rules (
  day_of_week int primary key check (day_of_week between 0 and 6), -- 0=日
  is_open boolean not null default true,
  open_min int,        -- 開店
  last_entry_min int,  -- Web予約で選べる最終スタート時刻
  close_min int        -- 閉店（受付期限の計算に使用）
);

-- ---------- 営業日カレンダー上書き（不定休・月曜団体営業・時間変更） ----------
create table special_days (
  date date primary key,
  type text not null check (type in ('closed', 'open', 'special')),
  open_min int,
  last_entry_min int,
  close_min int,
  note text
);

-- ---------- コース ----------
create table courses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price int not null,
  description text,
  includes_nomihodai boolean not null default false,
  allow_nomihodai_addon boolean not null default false, -- +1,500円で飲み放題追加可か
  stay_minutes int not null default 120,
  active boolean not null default true,
  sort int not null default 0
);

-- ---------- 顧客リスト ----------
create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null unique,
  email text,
  visit_count int not null default 0,
  last_visit date,
  tags text,
  notes text,
  created_at timestamptz not null default now()
);

-- ---------- 予約 ----------
create table reservations (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'web'
    check (source in ('web', 'hotpepper', 'phone', 'walkin')),
  status text not null default 'confirmed'
    check (status in ('pending', 'confirmed', 'cancelled', 'seated', 'finished', 'noshow')),
  date date not null,             -- 営業日（25:00スタートでも前日の営業日に属する）
  start_min int not null,         -- 営業日0:00からの経過分
  party_size int not null check (party_size >= 1),
  seat_type_id uuid references seat_types (id),  -- 団体仮受付中は null
  course_id uuid references courses (id),        -- 席のみ予約は null
  drink_option text not null default 'none'
    check (drink_option in ('none', 'included', 'add_1500', 'standalone_3500')),
  customer_id uuid references customers (id),
  customer_name text not null,
  customer_phone text not null,
  customer_email text,
  notes text,
  cancel_token uuid not null default gen_random_uuid(),
  created_by text not null default 'web',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_reservations_date on reservations (date);
create index idx_reservations_cancel_token on reservations (cancel_token);
create index idx_reservations_phone on reservations (customer_phone);

-- ---------- 店舗設定（1行のみ） ----------
create table settings (
  id int primary key default 1 check (id = 1),
  notification_emails text[] not null default '{}', -- 予約受け取り用（複数登録可）
  reply_to_email text,
  default_stay_minutes int not null default 120,
  group_threshold int not null default 9,   -- この人数以上は仮受付→店から電話
  slot_minutes int not null default 30,
  cancel_deadline_min int not null default 1080 -- 前日18:00 = 1080分
);

-- ---------- 通知ログ ----------
create table notification_log (
  id bigint generated always as identity primary key,
  reservation_id uuid references reservations (id),
  channel text not null, -- email_customer / email_store / line / reminder
  status text not null,  -- sent / failed
  detail text,
  created_at timestamptz not null default now()
);

-- ---------- 監査ログ（スタッフ操作記録） ----------
create table audit_log (
  id bigint generated always as identity primary key,
  actor text not null,       -- スタッフのメール or 'system'
  action text not null,
  target_id uuid,
  detail jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================
-- RLS: 既定で全拒否（ポリシーを作らない = anon/authenticated は読み書き不可）
-- アクセスはすべて Edge Function（service_role）経由。
-- Phase 3 でスタッフ（authenticated）用の閲覧ポリシーを追加する。
-- ============================================================
alter table seat_types enable row level security;
alter table schedule_rules enable row level security;
alter table special_days enable row level security;
alter table courses enable row level security;
alter table customers enable row level security;
alter table reservations enable row level security;
alter table settings enable row level security;
alter table notification_log enable row level security;
alter table audit_log enable row level security;

-- ============================================================
-- 関数
-- ============================================================

-- その日の営業情報（special_days が schedule_rules を上書き）
create or replace function fn_day_schedule(p_date date)
returns table (is_open boolean, open_min int, last_entry_min int, close_min int)
language sql stable as $$
  select
    case
      when sd.type = 'closed' then false
      when sd.type in ('open', 'special') then true
      else coalesce(sr.is_open, false)
    end,
    coalesce(sd.open_min, sr.open_min),
    coalesce(sd.last_entry_min, sr.last_entry_min),
    coalesce(sd.close_min, sr.close_min)
  from (select 1) dummy
  left join schedule_rules sr on sr.day_of_week = extract(dow from p_date)::int
  left join special_days sd on sd.date = p_date;
$$;

-- 指定日時・人数で空いている席を1つ選ぶ（1Fのみ・自動引当用）
-- 戻り値: 席種id（null = 空きなし）
create or replace function fn_pick_seat(p_date date, p_start_min int, p_party int)
returns uuid
language plpgsql stable as $$
declare
  v_stay int;
  v_seat uuid;
begin
  select default_stay_minutes into v_stay from settings where id = 1;

  -- 個室型: 予約が重なっていない部屋のうち、定員が最小のもの
  select st.id into v_seat
  from seat_types st
  where st.active and st.floor = 1 and st.exclusive
    and p_party between st.min_party and st.max_party
    and not exists (
      select 1 from reservations r
      where r.seat_type_id = st.id
        and r.date = p_date
        and r.status in ('pending', 'confirmed', 'seated')
        and r.start_min < p_start_min + v_stay
        and r.start_min + v_stay > p_start_min
    )
  order by st.max_party asc
  limit 1;
  if v_seat is not null then return v_seat; end if;

  -- 相席型: 残席（定員 − 重なる予約の人数合計）が足りる席のうち残りが最小のもの
  select st.id into v_seat
  from seat_types st
  where st.active and st.floor = 1 and not st.exclusive
    and p_party between st.min_party and st.max_party
    and st.total_capacity - coalesce((
      select sum(r.party_size) from reservations r
      where r.seat_type_id = st.id
        and r.date = p_date
        and r.status in ('pending', 'confirmed', 'seated')
        and r.start_min < p_start_min + v_stay
        and r.start_min + v_stay > p_start_min
    ), 0) >= p_party
  order by st.total_capacity asc
  limit 1;

  return v_seat; -- null なら満席
end;
$$;

-- その日の予約可能スロット一覧（Webフォームの時間選択に使用）
create or replace function fn_day_slots(p_date date, p_party int)
returns table (start_min int, available boolean)
language plpgsql stable as $$
declare
  v_open int; v_last int; v_is_open boolean; v_slot int; v_threshold int;
  v_min int;
begin
  select s.slot_minutes, s.group_threshold into v_slot, v_threshold from settings s where s.id = 1;
  select ds.is_open, ds.open_min, ds.last_entry_min into v_is_open, v_open, v_last
  from fn_day_schedule(p_date) ds;

  if not coalesce(v_is_open, false) or v_open is null or v_last is null then
    return; -- 休業日はスロットなし
  end if;

  v_min := v_open;
  while v_min <= v_last loop
    if p_party >= v_threshold then
      -- 団体は人数無制限で仮受付できるため常に選択可
      return query select v_min, true;
    else
      return query select v_min, fn_pick_seat(p_date, v_min, p_party) is not null;
    end if;
    v_min := v_min + v_slot;
  end loop;
end;
$$;

-- 期間内の営業/休業一覧（カレンダー表示用）
create or replace function fn_calendar(p_from date, p_to date)
returns table (date date, is_open boolean)
language sql stable as $$
  select d::date, (select ds.is_open from fn_day_schedule(d::date) ds)
  from generate_series(p_from, p_to, interval '1 day') d;
$$;

-- 予約の作成（Edge Function から呼ぶ。トランザクション内で残席を再チェック）
create or replace function fn_create_reservation(
  p_date date,
  p_start_min int,
  p_party int,
  p_course_id uuid,
  p_drink_option text,
  p_name text,
  p_phone text,
  p_email text,
  p_notes text
)
returns json
language plpgsql as $$
declare
  v settings%rowtype;
  v_is_open boolean; v_open int; v_last int;
  v_prev_close int;
  v_deadline timestamp;
  -- timestamptz AT TIME ZONE 'Asia/Tokyo' は「日本時間の壁時計時刻」(timestamp)を返す
  v_now_jst timestamp := now() at time zone 'Asia/Tokyo';
  v_seat uuid;
  v_status text;
  v_customer uuid;
  v_res reservations%rowtype;
begin
  select * into v from settings where id = 1;

  -- 同一日への同時アクセスを直列化（二重予約防止。ロックは本トランザクション内のみ）
  perform pg_advisory_xact_lock(hashtext('resv_' || p_date::text));

  -- 営業日チェック
  select ds.is_open, ds.open_min, ds.last_entry_min into v_is_open, v_open, v_last
  from fn_day_schedule(p_date) ds;
  if not coalesce(v_is_open, false) then
    raise exception 'DAY_CLOSED';
  end if;
  if p_start_min < v_open or p_start_min > v_last then
    raise exception 'OUT_OF_HOURS';
  end if;

  -- 受付期限: 来店前日の閉店時刻まで（前日休業なら前日24:00まで）
  select coalesce(ds.close_min, 1440) into v_prev_close
  from fn_day_schedule(p_date - 1) ds;
  v_deadline := (p_date - 1)::timestamp + make_interval(mins => v_prev_close);
  if v_now_jst > v_deadline then
    raise exception 'DEADLINE_PASSED';
  end if;

  -- 席の引当（団体は仮受付・席は電話確認後にスタッフが割当）
  if p_party >= v.group_threshold then
    v_status := 'pending';
    v_seat := null;
  else
    v_status := 'confirmed';
    v_seat := fn_pick_seat(p_date, p_start_min, p_party);
    if v_seat is null then
      raise exception 'FULL';
    end if;
  end if;

  -- 顧客リストへ登録（電話番号で名寄せ）
  insert into customers (name, phone, email)
  values (p_name, p_phone, p_email)
  on conflict (phone) do update
    set name = excluded.name,
        email = coalesce(excluded.email, customers.email)
  returning id into v_customer;

  insert into reservations
    (source, status, date, start_min, party_size, seat_type_id, course_id,
     drink_option, customer_id, customer_name, customer_phone, customer_email,
     notes, created_by)
  values
    ('web', v_status, p_date, p_start_min, p_party, v_seat, p_course_id,
     p_drink_option, v_customer, p_name, p_phone, p_email, p_notes, 'web')
  returning * into v_res;

  return json_build_object(
    'id', v_res.id,
    'status', v_res.status,
    'cancel_token', v_res.cancel_token,
    'date', v_res.date,
    'start_min', v_res.start_min,
    'party_size', v_res.party_size
  );
end;
$$;

-- ============================================================
-- 初期データ（数値は設計書v1.3の仮確定値。管理画面/SQLで変更可能）
-- ============================================================

insert into schedule_rules (day_of_week, is_open, open_min, last_entry_min, close_min) values
  (0, true,  1080, 1320, 1440), -- 日: 18:00-24:00 / 最終入店22:00(仮)
  (1, false, null, null, null), -- 月: 定休
  (2, true,  1080, 1410, 1530), -- 火: 18:00-25:30 / 最終入店23:30(仮)
  (3, true,  1080, 1410, 1530),
  (4, true,  1080, 1410, 1530),
  (5, true,  1080, 1410, 1530),
  (6, true,  1080, 1410, 1530);

insert into seat_types (name, floor, exclusive, total_capacity, min_party, max_party, sort) values
  ('カウンター',   1, false, 8,  1, 8,  1),
  ('完全個室',     1, true,  8,  2, 8,  2),
  ('半個室A',      1, true,  5,  2, 5,  3),
  ('半個室B',      1, true,  4,  2, 4,  4),
  ('半個室C',      1, true,  7,  2, 7,  5), -- 6〜7名(仮: min要確認)
  ('テーブル席',   1, false, 10, 1, 10, 6),
  ('2F宴会フロア', 2, false, 60, 9, 60, 7); -- 30名以上で解放が基本運用(引当はスタッフ判断)

insert into courses (name, price, includes_nomihodai, allow_nomihodai_addon, sort) values
  ('女子会コース',       3980, true,  false, 1),
  ('スタンダードコース', 4000, false, true,  2),
  ('宴会限定コース',     5500, true,  false, 3),
  ('プレミアムコース',   6000, false, true,  4),
  ('宮崎牛コース',       8000, false, true,  5);

insert into settings (id) values (1);
