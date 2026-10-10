-- Tables the app copies into Supabase (Postgres).
-- Run once in Supabase > SQL Editor, then `npm run supabase:backfill`.
--
-- The app writes with the service-role key; row level security is on with no
-- policies, so the public anon key can read nothing. For Power BI, connect with
-- the read-only `reporting` user created at the bottom.
--
-- Money is in paise (₹1 = 100). The views at the bottom give rupees and IST.
-- No foreign keys: the app is the source of truth and rows may arrive in any order.

create table if not exists outlets (
  id integer primary key,
  slug text unique not null,
  name text not null,
  city text not null,
  address text not null,
  lat double precision not null,
  lng double precision not null,
  phone text not null,
  delivery_radius_km double precision not null,
  upi_id text,
  upi_name text,
  sfx_store_code text,
  wa_payment_config text,
  opens text not null,
  closes text not null,
  accepting_orders boolean not null default true,
  active boolean not null default true
);

create table if not exists menu_items (
  id integer primary key,
  category text not null,
  name text not null,
  description text not null default '',
  price integer not null,
  veg boolean not null default true,
  sort integer not null default 0,
  active boolean not null default true
);

create table if not exists outlet_unavailable_items (
  outlet_id integer not null,
  item_id integer not null,
  primary key (outlet_id, item_id)
);

create table if not exists outlet_stock (
  outlet_id integer not null,
  item_id integer not null,
  remaining integer not null,
  updated_at timestamptz not null,
  primary key (outlet_id, item_id)
);

create table if not exists customers (
  phone text primary key,
  name text,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  first_channel text,
  last_address text,
  last_lat double precision,
  last_lng double precision,
  last_outlet_id integer,
  marketing_opt_in boolean not null default false,
  tags text not null default '',
  notes text not null default ''
);

create table if not exists orders (
  id integer primary key,
  code text unique not null,
  outlet_id integer not null,
  channel text not null,
  fulfilment text not null,
  customer_name text not null,
  phone text not null,
  address text,
  lat double precision,
  lng double precision,
  distance_km double precision,
  notes text,
  subtotal integer not null,
  packing integer not null,
  gst integer not null,
  delivery_fee integer not null,
  total integer not null,
  payment_method text not null,
  payment_status text not null,
  status text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists orders_created on orders (created_at);
create index if not exists orders_phone on orders (phone);

create table if not exists order_items (
  line_id integer primary key,
  order_id integer not null,
  item_id integer not null,
  name text not null,
  price integer not null,
  qty integer not null,
  note text
);
create index if not exists order_items_order on order_items (order_id);

create table if not exists order_events (
  id integer primary key,
  order_id integer not null,
  status text not null,
  at timestamptz not null
);
create index if not exists order_events_order on order_events (order_id);

create table if not exists deliveries (
  order_id integer primary key,
  provider text not null,
  ref text,
  status text not null,
  rider_name text,
  rider_phone text,
  rider_lat double precision,
  rider_lng double precision,
  track_url text,
  error text,
  updated_at timestamptz not null
);

create table if not exists loyalty_ledger (
  id integer primary key,
  phone text not null,
  order_id integer,
  points integer not null,
  kind text not null,
  note text,
  at timestamptz not null
);
create index if not exists loyalty_phone on loyalty_ledger (phone);

create table if not exists ratings (
  order_id integer not null,
  item_id integer not null, -- 0 = the whole order
  name text not null,
  stars integer not null,
  outlet_id integer not null,
  phone text not null,
  at timestamptz not null,
  primary key (order_id, item_id)
);

create table if not exists review_comments (
  order_id integer primary key,
  comment text not null,
  at timestamptz not null
);

create table if not exists price_history (
  id integer primary key,
  batch text not null,
  item_id integer not null,
  old_price integer not null,
  new_price integer not null,
  note text,
  at timestamptz not null
);

-- Lock the tables away from the public API keys.
do $$
declare t text;
begin
  foreach t in array array['outlets','menu_items','outlet_unavailable_items','outlet_stock','customers','orders',
    'order_items','order_events','deliveries','loyalty_ledger','ratings','review_comments','price_history']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- ---- Reporting views (rupees, IST) ----------------------------------------
-- security_invoker: the views obey the same row level security as the tables,
-- so they can't leak data through the public API either.

create or replace view v_orders with (security_invoker = true) as
select o.id, o.code, o.created_at at time zone 'Asia/Kolkata' as created_ist,
  (o.created_at at time zone 'Asia/Kolkata')::date as day_ist,
  extract(hour from o.created_at at time zone 'Asia/Kolkata')::int as hour_ist,
  to_char(o.created_at at time zone 'Asia/Kolkata', 'Dy') as weekday,
  ot.name as outlet, o.channel, o.fulfilment, o.status, o.payment_method, o.payment_status,
  o.phone, o.customer_name, o.distance_km,
  round(o.subtotal / 100.0, 2) as items_rs, round(o.packing / 100.0, 2) as packing_rs, round(o.gst / 100.0, 2) as gst_rs,
  round(o.delivery_fee / 100.0, 2) as delivery_rs, round(o.total / 100.0, 2) as total_rs
from orders o join outlets ot on ot.id = o.outlet_id;

create or replace view v_order_lines with (security_invoker = true) as
select i.line_id, i.order_id, o.code, o.day_ist, o.hour_ist, o.outlet, o.status,
  m.category, i.item_id, i.name as item, i.qty, round(i.price / 100.0, 2) as price_rs,
  round(i.qty * i.price / 100.0, 2) as line_total_rs, i.note
from order_items i join v_orders o on o.id = i.order_id
left join menu_items m on m.id = i.item_id;

create or replace view v_item_ratings with (security_invoker = true) as
select r.item_id, r.name as item, count(*) as ratings, round(avg(r.stars), 2) as avg_stars,
  count(*) filter (where r.stars <= 2) as low_ratings
from ratings r where r.item_id <> 0
group by r.item_id, r.name;

create or replace view v_customers with (security_invoker = true) as
select c.phone, c.name, c.first_seen_at, c.last_seen_at, c.marketing_opt_in, c.tags,
  coalesce(l.points, 0) as points,
  coalesce(s.orders, 0) as orders, coalesce(s.spent_rs, 0) as spent_rs
from customers c
left join (select phone, sum(points) as points from loyalty_ledger group by phone) l on l.phone = c.phone
left join (select phone, count(*) as orders, round(sum(total) / 100.0, 2) as spent_rs
           from orders where status = 'completed' group by phone) s on s.phone = c.phone;

-- ---- Read-only user for Power BI / Metabase / Looker Studio --------------
-- Uncomment, set a strong password, run once. Connect with the Session pooler
-- host from Supabase > Connect, user `reporting.<project-ref>`.
--
-- create role reporting login password 'CHANGE-ME';
-- grant usage on schema public to reporting;
-- grant select on all tables in schema public to reporting;
-- alter default privileges in schema public grant select on tables to reporting;
-- -- RLS is on: let the reporting role read every row (read only).
-- do $$
-- declare t text;
-- begin
--   foreach t in array array['outlets','menu_items','outlet_unavailable_items','outlet_stock','customers','orders',
--     'order_items','order_events','deliveries','loyalty_ledger','ratings','review_comments','price_history']
--   loop
--     execute format('create policy reporting_read on %I for select to reporting using (true)', t);
--   end loop;
-- end $$;
