-- one chat -> many crm users
create table if not exists tg_link_users (
  chat_id bigint not null references tg_links(chat_id) on delete cascade,
  crm_user_id bigint not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (chat_id, crm_user_id)
);

create index if not exists idx_tg_link_users_crm_user_id
  on tg_link_users (crm_user_id);

create index if not exists idx_tg_link_users_chat_id_active
  on tg_link_users (chat_id, is_active);

create index if not exists idx_tg_link_users_crm_user_id_active
  on tg_link_users (crm_user_id, is_active);

drop trigger if exists trg_tg_link_users_updated_at on tg_link_users;

create trigger trg_tg_link_users_updated_at
before update on tg_link_users
for each row
execute function set_updated_at();
