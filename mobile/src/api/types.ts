// Mirrors backend/tnp/models.py. Datetimes are ISO-8601 strings.

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface CategoryCreate {
  name: string;
  color?: string | null;
  print_limit?: number;
}
export interface CategoryUpdate {
  name?: string | null;
  color?: string | null;
  print_limit?: number | null;
}
export interface Category {
  id: number;
  name: string;
  slug: string;
  color: string | null;
  print_limit: number;
  feed_count: number;
}

export interface FeedCreate {
  url: string;
  category_id: number;
  title?: string | null;
  enabled?: boolean;
}
export interface FeedUpdate {
  url?: string | null;
  category_id?: number | null;
  title?: string | null;
  enabled?: boolean | null;
}
export interface Feed {
  id: number;
  url: string;
  title: string | null;
  category_id: number;
  enabled: boolean;
  last_fetched_at: string | null;
  last_error: string | null;
}
export interface IngestResult {
  feeds_checked: number;
  new_articles: number;
  skipped_duplicates: number;
  flagged_political: number;
  errors: Record<string, string>;
}

export interface ArticleSummary {
  id: number;
  feed_id: number;
  category: Category;
  title: string;
  url: string;
  author: string | null;
  published_at: string | null;
  image_url: string | null;
  tldr: string | null;
  is_political: boolean | null;
  printed_at: string | null;
}
export interface ArticleDetail extends ArticleSummary {
  content_html: string | null;
  content_text: string | null;
}

export interface DigestItem {
  article_id: number;
  position: number;
  category_slug: string;
  tldr: string;
}

export type PrintStatus = 'pending' | 'printed' | 'failed';
export type PrintTrigger = 'manual' | 'schedule';

export interface PrintItem {
  position: number;
  article_id: number | null;
  category_slug: string;
  tldr: string;
  title?: string | null;
  url?: string | null;
  image_url?: string | null;
}
export interface PrintRecord {
  id: number;
  created_at: string;
  trigger: PrintTrigger;
  status: PrintStatus;
  error: string | null;
  items: PrintItem[];
}

export interface ScheduleCreate {
  cron: string;
  label?: string | null;
  enabled?: boolean;
}
export interface ScheduleUpdate {
  cron?: string | null;
  label?: string | null;
  enabled?: boolean | null;
}
export interface Schedule {
  id: number;
  cron: string;
  label: string | null;
  enabled: boolean;
}

export interface Settings {
  max_items_total: number;
  model: string;
  fallback_model: string | null;
  printer_address: string | null;
}

export interface ModelOption {
  id: string;
  label: string;
}

/** One story of the upcoming (persisted, AI-curated) edition, in print order. */
export interface EditionItem {
  position: number;
  article_id: number;
  category_slug: string;
  category: Category;
  title: string;
  url: string;
  image_url: string | null;
  published_at: string | null;
  /** null while the summary is still being written. */
  tldr: string | null;
  /** ISO timestamp when the user read it (opened the original or marked it), else null. */
  read_at: string | null;
}

export type EditionPhase = 'idle' | 'curating' | 'summarizing';

export interface EditionStatus {
  phase: EditionPhase;
  /** Summaries finished / expected while phase is 'summarizing'. */
  done: number;
  total: number;
  /** No OpenRouter key: the edition is a plain newest-first selection and cannot be summarized. */
  no_key: boolean;
  /** Most recent pipeline failure (redacted), so a blank edition is never unexplained. */
  last_error?: { stage: PipelineStage; message: string; at?: string };
}

export type PipelineStage = 'ingest' | 'curate' | 'summarize' | 'render' | 'print';
export type LastErrors = Partial<Record<PipelineStage, { message: string; at: string }>>;

export interface Edition {
  items: EditionItem[];
  status: EditionStatus;
  built_at: string | null;
  /** max_items_total from the settings: the size the edition aims for. */
  target: number;
}

/** One story of an archived edition (History). */
export interface HistoryItem {
  position: number;
  article_id: number | null;
  category_slug: string;
  category: Category | null;
  title: string | null;
  url: string | null;
  image_url: string | null;
  tldr: string | null;
  read_at: string | null;
}

/** An edition moved to History: printed (print_id set) or just shown and rolled over by "Fetch new news". */
export interface HistoryEdition {
  id: number;
  created_at: string;
  archived_at: string;
  print_id: number | null;
  printed: boolean;
  items: HistoryItem[];
}

export interface FetchNewsResult {
  ingest: IngestResult;
  edition: Edition;
}

export interface Diagnostics {
  /** Configuration hints, e.g. a useless fallback model. */
  hints?: string[];
  /** recency window the last edition needed (days); null = unlimited. */
  window_days?: number | null;
  /** per category: stored articles, unseen ones inside the window, stories in the current edition. */
  categories?: { slug: string; fetched: number; eligible: number; in_edition: number }[];
  last_errors: LastErrors;
  counts: {
    articles: number;
    /** curation candidates inside the age window. */
    candidates: number;
    edition_size: number;
    summarized: number;
  };
}

export interface AiKeyTestResult {
  ok: boolean;
  /** One entry per model tried (primary, then fallback). */
  results: { model: string; ok: boolean; message: string; status?: number }[];
}

/** Full surface of the REST contract (docs/ARCHITECTURE.md). */
export interface Api {
  health(): Promise<{ status: string }>;
  listCategories(): Promise<Category[]>;
  createCategory(body: CategoryCreate): Promise<Category>;
  updateCategory(id: number, body: CategoryUpdate): Promise<Category>;
  deleteCategory(id: number): Promise<void>;
  listFeeds(categoryId?: number | null): Promise<Feed[]>;
  createFeed(body: FeedCreate): Promise<Feed>;
  updateFeed(id: number, body: FeedUpdate): Promise<Feed>;
  deleteFeed(id: number): Promise<void>;
  refreshFeeds(feedId?: number | null): Promise<IngestResult>;
  listPrints(limit?: number, offset?: number): Promise<Page<PrintRecord>>;
  getPrint(id: number): Promise<PrintRecord>;
  listSchedules(): Promise<Schedule[]>;
  createSchedule(body: ScheduleCreate): Promise<Schedule>;
  updateSchedule(id: number, body: ScheduleUpdate): Promise<Schedule>;
  deleteSchedule(id: number): Promise<void>;
  getSettings(): Promise<Settings>;
  patchSettings(body: Partial<Settings>): Promise<Settings>;
  getModels(): Promise<ModelOption[]>;
  /** The persisted upcoming edition (what Feed and Preview show and what the next print uses). */
  getEdition(): Promise<Edition>;
  /** Re-curate the next edition now (single-flight; returns the current snapshot immediately). */
  rebuildEdition(): Promise<Edition>;
  /**
   * The current digest rendered as the 384px receipt image, as a displayable URI (data: URI on device,
   * cache-busted http URL in remote mode). Null when no renderer is available (demo mode, renderer
   * missing): the Preview screen then shows the in-app ReceiptMock approximation.
   */
  previewImage(): Promise<{ uri: string } | null>;
  printNow(): Promise<PrintRecord>;
  /** Archived editions (printed or rolled over), newest first, with their stories: one query. */
  listHistory(limit?: number): Promise<HistoryEdition[]>;
  /** Mark an article read / unread. */
  setRead(articleId: number, read: boolean): Promise<void>;
  /**
   * "Fetch new news": archive the current edition into History, ingest the feeds, then start curating a
   * fresh edition (summaries continue in the background).
   */
  fetchNews(): Promise<FetchNewsResult>;
  getDiagnostics(): Promise<Diagnostics>;
  /** One tiny request (max_tokens 5) with the configured model and fallback. */
  testAiKey(): Promise<AiKeyTestResult>;
}
