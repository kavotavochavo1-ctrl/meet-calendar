-- Supabase → SQL Editor → вставь и Run.

create table meetings (
  id           bigint generated always as identity primary key,
  title        text not null,
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  participants jsonb not null default '[]',
  created_at   timestamptz not null default now()
);

-- Демо-доступ: разрешаем всем (anon) читать/писать.
-- Для реального прода так НЕ делают — тут это осознанно, инструмент временный.
alter table meetings enable row level security;

create policy "demo full access" on meetings
  for all using (true) with check (true);
