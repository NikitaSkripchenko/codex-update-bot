create table if not exists telegram_subscriptions (
  chat_id text primary key,
  chat_type text not null,
  status text not null,
  subscribed_at text not null,
  unsubscribed_at text,
  failure_count integer not null default 0,
  last_delivery_error text,
  last_delivery_error_at text
);

create index if not exists idx_telegram_subscriptions_status
  on telegram_subscriptions (status);

create table if not exists telegram_deliveries (
  alert_id text not null,
  chat_id text not null,
  status text not null default 'pending',
  claimed_until text,
  attempt_count integer not null default 0,
  delivered_at text,
  error text,
  updated_at text not null,
  primary key (alert_id, chat_id)
);

create index if not exists idx_telegram_deliveries_status
  on telegram_deliveries (status, updated_at);
