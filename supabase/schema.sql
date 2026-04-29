create table if not exists public.page_cache (
  key text primary key,
  url text not null,
  final_url text not null,
  html_hash text not null,
  html text not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists public.render_cache (
  key text primary key,
  url text not null,
  target_lang text not null,
  html_hash text not null,
  html text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists public.translation_cache (
  key text primary key,
  source_text_hash text not null,
  source_text text not null,
  target_lang text not null,
  translated_text text not null,
  created_at timestamptz not null default now()
);

create index if not exists page_cache_expires_at_idx on public.page_cache (expires_at);
create index if not exists render_cache_expires_at_idx on public.render_cache (expires_at);
create index if not exists translation_cache_lang_hash_idx
  on public.translation_cache (target_lang, source_text_hash);

alter table public.page_cache enable row level security;
alter table public.render_cache enable row level security;
alter table public.translation_cache enable row level security;

-- Access is intentionally server-only through SUPABASE_SERVICE_ROLE_KEY.
-- Do not create anon/client policies for these cache tables.

create table if not exists public.doc_sites (
  id uuid primary key,
  slug text not null unique,
  entry_url text not null,
  root_url text not null,
  scope_path text not null default '/',
  entry_path text not null,
  title text,
  target_langs text[] not null,
  status text not null check (status in ('queued', 'discovering', 'generating', 'ready', 'failed')),
  page_limit integer not null default 300,
  discovered_count integer not null default 0,
  generated_count integer not null default 0,
  failed_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.doc_sites add column if not exists scope_path text not null default '/';

create table if not exists public.source_pages (
  id uuid primary key,
  site_id uuid not null references public.doc_sites(id) on delete cascade,
  url text not null,
  path text not null,
  title text,
  html_hash text,
  status text not null check (status in ('queued', 'fetching', 'translating', 'publishing', 'ready', 'skipped', 'failed')),
  last_error text,
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, path)
);

alter table public.source_pages drop constraint if exists source_pages_status_check;
alter table public.source_pages
  add constraint source_pages_status_check
  check (status in ('queued', 'fetching', 'translating', 'publishing', 'ready', 'skipped', 'failed'));

create table if not exists public.mirrored_pages (
  id uuid primary key,
  site_id uuid not null references public.doc_sites(id) on delete cascade,
  source_page_id uuid not null references public.source_pages(id) on delete cascade,
  lang text not null,
  path text not null,
  html text not null,
  source_html_hash text not null,
  generated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, lang, path)
);

create table if not exists public.translation_segments (
  key text primary key,
  source_text_hash text not null,
  source_text text not null,
  target_lang text not null,
  translated_text text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.doc_sites(id) on delete cascade,
  status text not null default 'queued',
  trigger text not null default 'system',
  pages_total integer not null default 0,
  pages_done integer not null default 0,
  pages_failed integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

alter table public.generation_jobs add column if not exists trigger text not null default 'system';
alter table public.generation_jobs add column if not exists pages_total integer not null default 0;
alter table public.generation_jobs add column if not exists pages_done integer not null default 0;
alter table public.generation_jobs add column if not exists pages_failed integer not null default 0;
alter table public.generation_jobs add column if not exists last_error text;
alter table public.generation_jobs add column if not exists started_at timestamptz;
alter table public.generation_jobs add column if not exists finished_at timestamptz;

create table if not exists public.generation_locks (
  site_id uuid primary key references public.doc_sites(id) on delete cascade,
  job_id uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists public.job_events (
  id uuid primary key,
  site_id uuid not null references public.doc_sites(id) on delete cascade,
  level text not null check (level in ('info', 'error')),
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.site_votes (
  site_id uuid not null references public.doc_sites(id) on delete cascade,
  voter_key text not null,
  value integer not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (site_id, voter_key)
);

create table if not exists public.site_llm_texts (
  site_id uuid not null references public.doc_sites(id) on delete cascade,
  lang text not null,
  content text not null,
  page_count integer not null default 0,
  generated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (site_id, lang)
);

create table if not exists public.site_llm_text_locks (
  lock_key text primary key,
  site_id uuid not null references public.doc_sites(id) on delete cascade,
  lang text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists doc_sites_updated_at_idx on public.doc_sites (updated_at desc);
create index if not exists source_pages_site_status_idx on public.source_pages (site_id, status);
create index if not exists mirrored_pages_site_lang_path_idx on public.mirrored_pages (site_id, lang, path);
create index if not exists mirrored_pages_site_lang_path_summary_idx
  on public.mirrored_pages (site_id, lang, path)
  include (id, source_page_id, source_html_hash, generated_at, updated_at);
create index if not exists translation_segments_lang_hash_idx
  on public.translation_segments (target_lang, source_text_hash);
create index if not exists job_events_site_created_idx on public.job_events (site_id, created_at);
create index if not exists generation_jobs_site_status_updated_idx
  on public.generation_jobs (site_id, status, updated_at desc);
create index if not exists generation_locks_expires_at_idx
  on public.generation_locks (expires_at);
create index if not exists site_votes_site_value_idx
  on public.site_votes (site_id, value);
create index if not exists site_llm_texts_site_lang_idx
  on public.site_llm_texts (site_id, lang);
create index if not exists site_llm_text_locks_expires_at_idx
  on public.site_llm_text_locks (expires_at);

alter table public.doc_sites enable row level security;
alter table public.source_pages enable row level security;
alter table public.mirrored_pages enable row level security;
alter table public.translation_segments enable row level security;
alter table public.generation_jobs enable row level security;
alter table public.generation_locks enable row level security;
alter table public.job_events enable row level security;
alter table public.site_votes enable row level security;
alter table public.site_llm_texts enable row level security;
alter table public.site_llm_text_locks enable row level security;
