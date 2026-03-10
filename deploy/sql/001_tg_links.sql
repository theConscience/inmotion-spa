-- tg_links: persistent mapping Telegram chat <-> MoyKlass user / phone
create table if not exists tg_links (
  chat_id bigint primary key,
  phone text,
  crm_user_id bigint,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tg_links_phone on tg_links (phone);
create index if not exists idx_tg_links_crm_user_id on tg_links (crm_user_id);

-- ensure only one active chat per crm_user_id (optional but useful)
create unique index if not exists uq_tg_links_crm_user_id_active
  on tg_links (crm_user_id)
  where crm_user_id is not null and is_active = true;
