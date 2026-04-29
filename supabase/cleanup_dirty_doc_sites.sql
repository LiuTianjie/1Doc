-- Preview doc_sites that are marked ready but have no mirrored page in any target language.
-- These records cannot produce a homepage/search card mirror URL.
select
  ds.id,
  ds.slug,
  ds.entry_url,
  ds.target_langs,
  ds.generated_count,
  ds.failed_count,
  ds.updated_at
from public.doc_sites ds
where ds.status = 'ready'
  and not exists (
    select 1
    from public.mirrored_pages mp
    where mp.site_id = ds.id
      and mp.lang = any(ds.target_langs)
  )
order by ds.updated_at desc;

-- Delete the same dirty records.
-- Related site data is removed by foreign-key cascades:
-- source_pages, mirrored_pages, generation_jobs, generation_locks,
-- job_events, site_votes, site_llm_texts, site_llm_text_locks.
--
-- Cross-site caches are intentionally not deleted:
-- page_cache, render_cache, translation_cache, translation_segments.
begin;

with dirty_sites as (
  select ds.id
  from public.doc_sites ds
  where ds.status = 'ready'
    and not exists (
      select 1
      from public.mirrored_pages mp
      where mp.site_id = ds.id
        and mp.lang = any(ds.target_langs)
    )
),
deleted_sites as (
  delete from public.doc_sites ds
  using dirty_sites
  where ds.id = dirty_sites.id
  returning ds.id, ds.slug, ds.entry_url
)
select * from deleted_sites order by slug;

commit;
