export type SiteStatus = "queued" | "discovering" | "generating" | "ready" | "failed";
export type PageStatus = "queued" | "fetching" | "translating" | "publishing" | "ready" | "skipped" | "failed";

export type DocSite = {
  id: string;
  slug: string;
  entry_url: string;
  root_url: string;
  scope_path: string;
  entry_path: string;
  title: string | null;
  target_langs: string[];
  status: SiteStatus;
  page_limit: number;
  discovered_count: number;
  generated_count: number;
  failed_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type SourcePage = {
  id: string;
  site_id: string;
  url: string;
  path: string;
  title: string | null;
  html_hash: string | null;
  status: PageStatus;
  last_error: string | null;
  discovered_at: string;
  updated_at: string;
};

export type MirroredPage = {
  id: string;
  site_id: string;
  source_page_id: string;
  lang: string;
  path: string;
  html: string;
  source_html_hash: string;
  generated_at: string;
  updated_at: string;
};

export type MirroredPageSummary = Omit<MirroredPage, "html">;

export type JobEvent = {
  id: string;
  site_id: string;
  level: "info" | "error";
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type SiteVote = {
  site_id: string;
  voter_key: string;
  value: -1 | 1;
  created_at: string;
  updated_at: string;
};

export type SiteVoteStats = {
  upvote_count: number;
  downvote_count: number;
  vote_score: number;
  user_vote: -1 | 0 | 1;
};

export type SiteLlmText = {
  site_id: string;
  lang: string;
  content: string;
  page_count: number;
  generated_at: string;
  updated_at: string;
};

export type GenerationJobStatus = "queued" | "running" | "succeeded" | "failed" | "skipped";

export type GenerationJob = {
  id: string;
  site_id: string;
  status: GenerationJobStatus;
  trigger: "create" | "refresh" | "retry" | "system";
  pages_total: number;
  pages_done: number;
  pages_failed: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type GenerationMode = "incremental" | "retry_failed";

export type CreateSiteInput = {
  entryUrl: string;
  targetLangs: string[];
  pageLimit?: number;
};

export type SiteProgress = {
  site: DocSite;
  pages: Array<Omit<SourcePage, "site_id">>;
  mirroredPages: Array<Pick<MirroredPageSummary, "lang" | "path" | "source_html_hash" | "generated_at">>;
  llmTexts: Array<Pick<SiteLlmText, "lang" | "page_count" | "generated_at" | "updated_at">>;
  events: JobEvent[];
  jobs: GenerationJob[];
};
