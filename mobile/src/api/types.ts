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
  printer_address: string | null;
}

export interface ArticleQuery {
  category_id?: number | null;
  limit?: number;
  offset?: number;
  include_political?: boolean;
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
  listArticles(q?: ArticleQuery): Promise<Page<ArticleSummary>>;
  getArticle(id: number): Promise<ArticleDetail>;
  listPrints(limit?: number, offset?: number): Promise<Page<PrintRecord>>;
  getPrint(id: number): Promise<PrintRecord>;
  listSchedules(): Promise<Schedule[]>;
  createSchedule(body: ScheduleCreate): Promise<Schedule>;
  updateSchedule(id: number, body: ScheduleUpdate): Promise<Schedule>;
  deleteSchedule(id: number): Promise<void>;
  getSettings(): Promise<Settings>;
  patchSettings(body: Partial<Settings>): Promise<Settings>;
  digestPreview(): Promise<DigestItem[]>;
  /** Preview PNG URL (cache-busted). Null in demo mode (in-app mock receipt is rendered instead). */
  previewUrl(nonce: number): string | null;
  /** Probe the renderer: throws ApiError(501) when unavailable. */
  checkPreview(): Promise<void>;
  printNow(): Promise<PrintRecord>;
}
