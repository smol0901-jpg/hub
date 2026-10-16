-- ============================================================
-- LLM Hub — схема Supabase (SQL Editor → Run)
-- ============================================================
create extension if not exists "pgcrypto";

-- Админы: после первого входа Auth добавьте свой user_id
create table if not exists public.hub_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

create table if not exists public.llm_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  display_name text not null default '',
  api_key text not null unique,
  enabled boolean not null default true,
  rate_limit_day int not null default 500,
  notes text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists llm_projects_api_key_idx on public.llm_projects (api_key);
create index if not exists llm_projects_name_idx on public.llm_projects (name);

create table if not exists public.llm_provider_secrets (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  label text not null default 'default',
  client_id text,
  client_secret text,
  auth_key text,
  scope text default 'GIGACHAT_API_PERS',
  api_key text,
  base_url text,
  default_model text,
  extra_json jsonb default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, label)
);

create table if not exists public.llm_project_providers (
  project_id uuid not null references public.llm_projects(id) on delete cascade,
  provider text not null,
  secret_label text not null default 'default',
  primary key (project_id, provider)
);

create table if not exists public.llm_usage (
  id bigserial primary key,
  project_id uuid references public.llm_projects(id) on delete set null,
  provider text,
  model text,
  ok boolean not null default false,
  status_code int,
  error_brief text,
  request_preview text,
  tokens_prompt int default 0,
  tokens_completion int default 0,
  tokens_total int default 0,
  latency_ms int default 0,
  created_at timestamptz not null default now()
);
create index if not exists llm_usage_project_day_idx on public.llm_usage (project_id, created_at desc);

create or replace function public.llm_generate_api_key()
returns text language sql as $$
  select 'orb_live_' || encode(gen_random_bytes(24), 'hex');
$$;

create or replace function public.is_hub_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.hub_admins a where a.user_id = auth.uid()
  );
$$;

create or replace function public.llm_auth_project(p_key text)
returns table (
  project_id uuid,
  project_name text,
  enabled boolean,
  rate_limit_day int,
  used_today bigint
) language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_name text; v_en boolean; v_lim int; v_used bigint;
begin
  select p.id, p.name, p.enabled, p.rate_limit_day into v_id, v_name, v_en, v_lim
  from public.llm_projects p where p.api_key = p_key limit 1;
  if v_id is null then return; end if;
  select count(*) into v_used from public.llm_usage u
  where u.project_id = v_id and u.created_at >= date_trunc('day', now() at time zone 'utc');
  return query select v_id, v_name, v_en, v_lim, coalesce(v_used, 0);
end;
$$;

create or replace function public.llm_get_secret(p_project_id uuid, p_provider text)
returns table (
  provider text, client_id text, client_secret text, auth_key text, scope text,
  api_key text, base_url text, default_model text, extra_json jsonb
) language plpgsql security definer set search_path = public as $$
declare v_label text := 'default';
begin
  select pp.secret_label into v_label from public.llm_project_providers pp
  where pp.project_id = p_project_id and pp.provider = p_provider limit 1;
  if v_label is null then v_label := 'default'; end if;
  return query
  select s.provider, s.client_id, s.client_secret, s.auth_key, s.scope,
         s.api_key, s.base_url, s.default_model, s.extra_json
  from public.llm_provider_secrets s
  where s.provider = p_provider and s.label = v_label and s.enabled = true limit 1;
end;
$$;

alter table public.hub_admins enable row level security;
alter table public.llm_projects enable row level security;
alter table public.llm_provider_secrets enable row level security;
alter table public.llm_project_providers enable row level security;
alter table public.llm_usage enable row level security;

drop policy if exists hub_admins_self on public.hub_admins;
create policy hub_admins_self on public.hub_admins for select to authenticated
  using (user_id = auth.uid() or public.is_hub_admin());

drop policy if exists projects_admin_all on public.llm_projects;
create policy projects_admin_all on public.llm_projects for all to authenticated
  using (public.is_hub_admin()) with check (public.is_hub_admin());

drop policy if exists usage_admin_select on public.llm_usage;
create policy usage_admin_select on public.llm_usage for select to authenticated
  using (public.is_hub_admin());

drop policy if exists pp_admin_all on public.llm_project_providers;
create policy pp_admin_all on public.llm_project_providers for all to authenticated
  using (public.is_hub_admin()) with check (public.is_hub_admin());

-- Секреты провайдеров: НЕТ политик для authenticated → только service_role / functions

-- Статистика для админки
create or replace function public.hub_stats_summary(p_days int default 7)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.is_hub_admin() then
    raise exception 'not admin';
  end if;
  select jsonb_build_object(
    'projects_total', (select count(*) from llm_projects),
    'projects_enabled', (select count(*) from llm_projects where enabled),
    'requests', (select count(*) from llm_usage where created_at >= now() - make_interval(days => p_days)),
    'ok', (select count(*) from llm_usage where ok and created_at >= now() - make_interval(days => p_days)),
    'tokens', (select coalesce(sum(tokens_total),0) from llm_usage where created_at >= now() - make_interval(days => p_days)),
    'by_project', (
      select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
        select p.name, p.display_name, p.enabled,
          count(u.id) as requests,
          coalesce(sum(u.tokens_total),0) as tokens
        from llm_projects p
        left join llm_usage u on u.project_id = p.id and u.created_at >= now() - make_interval(days => p_days)
        group by p.id order by requests desc
      ) t
    )
  ) into result;
  return result;
end;
$$;

grant execute on function public.hub_stats_summary(int) to authenticated;
grant execute on function public.is_hub_admin() to authenticated;
