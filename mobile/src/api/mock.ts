import { ApiError } from './errors';
import type {
  Api,
  ArticleDetail,
  ArticleSummary,
  Category,
  DigestItem,
  Feed,
  PrintRecord,
  Schedule,
  Settings,
} from './types';

/** In-memory mock of the whole REST contract. State lives for the app session. */

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const delay = <T>(v: T, ms = 250): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

interface CatRow {
  id: number;
  name: string;
  slug: string;
  color: string | null;
  print_limit: number;
}
interface ArtRow {
  id: number;
  feed_id: number;
  title: string;
  url: string;
  author: string | null;
  published_at: string | null;
  image_url: string | null;
  tldr: string | null;
  content_html: string;
}

const cats: CatRow[] = [
  { id: 1, name: 'Products', slug: 'products', color: '#E8590C', print_limit: 3 },
  { id: 2, name: 'Engineering', slug: 'engineering', color: '#1C7ED6', print_limit: 2 },
  { id: 3, name: 'Psychology', slug: 'psychology', color: '#AE3EC9', print_limit: 1 },
  { id: 4, name: 'Learning', slug: 'learning', color: '#2F9E44', print_limit: 2 },
];

const feeds: Feed[] = [
  { id: 1, url: 'https://hnrss.org/launches', title: 'Hacker News: Launches', category_id: 1, enabled: true, last_fetched_at: iso(12), last_error: null },
  { id: 2, url: 'https://techcrunch.com/category/startups/feed/', title: 'TechCrunch Startups', category_id: 1, enabled: true, last_fetched_at: iso(12), last_error: null },
  { id: 3, url: 'https://blog.pragmaticengineer.com/rss/', title: 'The Pragmatic Engineer', category_id: 2, enabled: true, last_fetched_at: iso(12), last_error: null },
  { id: 4, url: 'http://freakonomics.blogs.nytimes.com/feed/', title: 'Freakonomics', category_id: 3, enabled: true, last_fetched_at: iso(300), last_error: 'HTTP 404 fetching feed (demo error)' },
  { id: 5, url: 'https://feeds.feedburner.com/bigthink/main', title: 'Big Think', category_id: 4, enabled: true, last_fetched_at: iso(12), last_error: null },
];

const img = (seed: string) => `https://picsum.photos/seed/${seed}/640/360`;

const articles: ArtRow[] = [
  {
    id: 1, feed_id: 1, title: 'Launch HN: Pocketwave (YC W26) - Pocket-sized software-defined radio',
    url: 'https://news.ycombinator.com/item?id=1', author: 'pocketwave', published_at: iso(40), image_url: img('radio'),
    tldr: 'A YC startup shipped a pocket software-defined radio that decodes weather satellites and ham bands on a phone, for under $60.',
    content_html: '<p>We built <strong>Pocketwave</strong>, a pocket-sized software-defined radio that talks to your phone over USB-C.</p><h3>Why</h3><p>Existing SDRs need a laptop and a rat\'s nest of cables. Ours decodes NOAA weather images, ADS-B aircraft and ham bands out of the box.</p><ul><li>24 MHz - 1.7 GHz range</li><li>Open firmware</li><li>$59 at launch</li></ul><p>We would love your feedback.</p>',
  },
  {
    id: 2, feed_id: 2, title: 'A seed-stage startup wants to make batteries from sand',
    url: 'https://techcrunch.com/2026/11/06/sand-batteries/', author: 'Maya Chen', published_at: iso(95), image_url: img('battery'),
    tldr: 'A new startup raised $12M to commercialize silicon-from-sand battery anodes that promise 40% more capacity than graphite.',
    content_html: '<p>Silicon anodes have long promised bigger batteries, but they swell and crack. <em>GrainCell</em> says its porous silicon, made from refined sand, survives 1,000 cycles.</p><blockquote>"We are not inventing new chemistry, just a new way to make the silicon," said the CEO.</blockquote><p>Pilot production begins next spring.</p>',
  },
  {
    id: 3, feed_id: 3, title: 'How Stripe designs its internal platforms',
    url: 'https://blog.pragmaticengineer.com/stripe-platforms/', author: 'Gergely Orosz', published_at: iso(180), image_url: img('stripe'),
    tldr: 'Stripe treats internal tools as products: dedicated PMs, adoption metrics, and a rule that platform teams must win users, never mandate them.',
    content_html: '<h2>Platforms as products</h2><p>Stripe\'s platform org runs like a startup inside the company. Each platform has a PM, a roadmap, and adoption targets.</p><h3>Three principles</h3><ol><li>Win users, do not force them.</li><li>Measure time saved per engineer.</li><li>Delete what nobody uses.</li></ol><p>The result: fewer, better tools and faster onboarding.</p>',
  },
  {
    id: 4, feed_id: 3, title: 'Inside the migration from monolith to cells',
    url: 'https://blog.pragmaticengineer.com/cells/', author: 'Gergely Orosz', published_at: iso(1500), image_url: null,
    tldr: 'Cell-based architecture splits a service into isolated copies, so a bad deploy only takes down a slice of users instead of everyone.',
    content_html: '<p>Cell-based architecture limits blast radius. Each <em>cell</em> is a full, independent copy of the stack serving a fraction of customers.</p><p>Teams report fewer incidents, but routing and data migration are the hard parts.</p>',
  },
  {
    id: 5, feed_id: 4, title: 'Why we procrastinate on the things we care about most',
    url: 'https://freakonomics.com/procrastination/', author: 'Stephen Dubner', published_at: iso(2000), image_url: img('clock'),
    tldr: 'Procrastination is less about laziness and more about avoiding the emotions a task stirs up; naming the feeling makes starting easier.',
    content_html: '<p>Researchers increasingly frame procrastination as an <strong>emotion regulation</strong> problem. We delay tasks that make us anxious, bored or unsure.</p><p>A small trick: say out loud what you are feeling, then commit to just five minutes.</p>',
  },
  {
    id: 6, feed_id: 5, title: 'The surprising science of learning a language as an adult',
    url: 'https://bigthink.com/learning/adult-language/', author: 'Big Think Staff', published_at: iso(600), image_url: img('language'),
    tldr: 'Adults learn grammar faster than kids; what they lack is immersion. Spaced repetition plus daily conversation closes the gap.',
    content_html: '<p>Contrary to the "critical period" myth, adults pick up grammar rules <em>faster</em> than children. The trouble is exposure.</p><p>Study: 20 minutes of spaced-repetition vocabulary plus one conversation a day beat classroom-only learners within 6 months.</p>',
  },
  {
    id: 7, feed_id: 5, title: 'Astronomers spot a rogue planet drifting in the dark',
    url: 'https://bigthink.com/starts-with-a-bang/rogue-planet/', author: 'Ethan Siegel', published_at: iso(3000), image_url: img('planet'),
    tldr: 'A Jupiter-mass planet with no star was imaged directly, still glowing from its formation, 20 light-years from Earth.',
    content_html: '<p>Using infrared data, astronomers directly imaged a free-floating planet roughly the mass of Jupiter. It still radiates heat from its formation.</p>',
  },
  {
    id: 8, feed_id: 1, title: 'Show HN: A markdown editor that runs entirely in your terminal',
    url: 'https://news.ycombinator.com/item?id=8', author: 'termdown', published_at: iso(4000), image_url: null,
    tldr: null,
    content_html: '<p>Termdown is a fast, keyboard-first markdown editor with live preview rendered in your terminal.</p>',
  },
];

const prints: PrintRecord[] = [
  {
    id: 2, created_at: iso(60 * 6), trigger: 'schedule', status: 'printed', error: null,
    items: [
      { position: 0, article_id: 3, category_slug: 'engineering', tldr: articles[2]!.tldr!, title: articles[2]!.title },
      { position: 1, article_id: 6, category_slug: 'learning', tldr: articles[5]!.tldr!, title: articles[5]!.title },
      { position: 2, article_id: 5, category_slug: 'psychology', tldr: articles[4]!.tldr!, title: articles[4]!.title },
    ],
  },
  {
    id: 1, created_at: iso(60 * 30), trigger: 'manual', status: 'failed', error: 'Printer not found (BLE scan timed out)',
    items: [{ position: 0, article_id: 7, category_slug: 'learning', tldr: articles[6]!.tldr!, title: articles[6]!.title }],
  },
];

const schedules: Schedule[] = [{ id: 1, cron: '0 8 * * *', label: 'Morning edition', enabled: true }];
let settings: Settings = { max_items_total: 8, model: 'google/gemma-3-12b-it', fallback_model: 'deepseek/deepseek-v4.1-flash', printer_address: null };
let nextIds = { cat: 5, feed: 6, sched: 2, print: 3 };

const catView = (c: CatRow): Category => ({ ...c, feed_count: feeds.filter((f) => f.category_id === c.id).length });
const mustCat = (id: number): CatRow => {
  const c = cats.find((x) => x.id === id);
  if (!c) throw new ApiError(404, 'Category not found');
  return c;
};
const mustFeed = (id: number): Feed => {
  const f = feeds.find((x) => x.id === id);
  if (!f) throw new ApiError(404, 'Feed not found');
  return f;
};
const printedAt = (articleId: number): string | null => {
  const p = [...prints].reverse().find((x) => x.items.some((i) => i.article_id === articleId));
  return p?.created_at ?? null;
};
const summaryOf = (a: ArtRow): ArticleSummary => {
  const feed = mustFeed(a.feed_id);
  return {
    id: a.id,
    feed_id: a.feed_id,
    category: catView(mustCat(feed.category_id)),
    title: a.title,
    url: a.url,
    author: a.author,
    published_at: a.published_at,
    image_url: a.image_url,
    tldr: a.tldr,
    is_political: false,
    printed_at: printedAt(a.id),
  };
};

function nextBatch(): DigestItem[] {
  const picked: DigestItem[] = [];
  const counts = new Map<number, number>();
  for (const a of articles) {
    if (!a.tldr || printedAt(a.id)) continue;
    const feed = feeds.find((f) => f.id === a.feed_id);
    const cat = feed && cats.find((c) => c.id === feed.category_id);
    if (!cat || !feed?.enabled) continue;
    const n = counts.get(cat.id) ?? 0;
    if (n >= cat.print_limit || picked.length >= settings.max_items_total) continue;
    counts.set(cat.id, n + 1);
    picked.push({ article_id: a.id, position: picked.length, category_slug: cat.slug, tldr: a.tldr });
  }
  return picked;
}

export function createMockApi(): Api {
  return {
    health: () => delay({ status: 'ok' }, 50),

    listCategories: () => delay(cats.map(catView)),
    createCategory: async (b) => {
      if (cats.some((c) => c.name.toLowerCase() === b.name.toLowerCase())) throw new ApiError(409, 'Category already exists');
      const row: CatRow = { id: nextIds.cat++, name: b.name, slug: slugify(b.name), color: b.color ?? null, print_limit: b.print_limit ?? 2 };
      cats.push(row);
      return delay(catView(row));
    },
    updateCategory: async (id, b) => {
      const c = mustCat(id);
      if (b.name != null) {
        c.name = b.name;
        c.slug = slugify(b.name);
      }
      if (b.color !== undefined) c.color = b.color;
      if (b.print_limit != null) c.print_limit = b.print_limit;
      return delay(catView(c));
    },
    deleteCategory: async (id) => {
      mustCat(id);
      cats.splice(cats.findIndex((c) => c.id === id), 1);
      for (const f of feeds.filter((x) => x.category_id === id)) {
        feeds.splice(feeds.indexOf(f), 1);
        for (let i = articles.length - 1; i >= 0; i--) if (articles[i]!.feed_id === f.id) articles.splice(i, 1);
      }
      return delay(undefined);
    },

    listFeeds: (categoryId) => delay(clone(feeds.filter((f) => categoryId == null || f.category_id === categoryId))),
    createFeed: async (b) => {
      mustCat(b.category_id);
      if (feeds.some((f) => f.url === b.url)) throw new ApiError(409, 'Feed already exists');
      const f: Feed = { id: nextIds.feed++, url: b.url, title: b.title ?? null, category_id: b.category_id, enabled: b.enabled ?? true, last_fetched_at: null, last_error: null };
      feeds.push(f);
      return delay(clone(f));
    },
    updateFeed: async (id, b) => {
      const f = mustFeed(id);
      if (b.url != null) f.url = b.url;
      if (b.category_id != null) f.category_id = mustCat(b.category_id).id;
      if (b.title !== undefined) f.title = b.title;
      if (b.enabled != null) f.enabled = b.enabled;
      return delay(clone(f));
    },
    deleteFeed: async (id) => {
      mustFeed(id);
      feeds.splice(feeds.findIndex((f) => f.id === id), 1);
      for (let i = articles.length - 1; i >= 0; i--) if (articles[i]!.feed_id === id) articles.splice(i, 1);
      return delay(undefined);
    },
    refreshFeeds: async (feedId) => {
      const targets = feeds.filter((f) => f.enabled && (feedId == null || f.id === feedId));
      targets.forEach((f) => (f.last_fetched_at = new Date().toISOString()));
      return delay({ feeds_checked: targets.length, new_articles: 0, skipped_duplicates: targets.length * 12, flagged_political: 1, errors: {} }, 700);
    },

    listArticles: async (q = {}) => {
      const rows = articles
        .filter((a) => {
          if (q.category_id == null) return true;
          return feeds.find((f) => f.id === a.feed_id)?.category_id === q.category_id;
        })
        .sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''));
      const limit = q.limit ?? 50;
      const offset = q.offset ?? 0;
      return delay({ items: rows.slice(offset, offset + limit).map(summaryOf), total: rows.length, limit, offset });
    },
    getArticle: async (id) => {
      const a = articles.find((x) => x.id === id);
      if (!a) throw new ApiError(404, 'Article not found');
      const d: ArticleDetail = {
        ...summaryOf(a),
        content_html: a.content_html,
        content_text: a.content_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      };
      return delay(d);
    },

    listPrints: async (limit = 20, offset = 0) => {
      const rows = [...prints].sort((a, b) => b.created_at.localeCompare(a.created_at));
      return delay(clone({ items: rows.slice(offset, offset + limit), total: rows.length, limit, offset }));
    },
    getPrint: async (id) => {
      const p = prints.find((x) => x.id === id);
      if (!p) throw new ApiError(404, 'Print not found');
      return delay(clone(p));
    },

    listSchedules: () => delay(clone(schedules)),
    createSchedule: async (b) => {
      const s: Schedule = { id: nextIds.sched++, cron: b.cron, label: b.label ?? null, enabled: b.enabled ?? true };
      schedules.push(s);
      return delay(clone(s));
    },
    updateSchedule: async (id, b) => {
      const s = schedules.find((x) => x.id === id);
      if (!s) throw new ApiError(404, 'Schedule not found');
      if (b.cron != null) s.cron = b.cron;
      if (b.label !== undefined) s.label = b.label;
      if (b.enabled != null) s.enabled = b.enabled;
      return delay(clone(s));
    },
    deleteSchedule: async (id) => {
      const i = schedules.findIndex((x) => x.id === id);
      if (i < 0) throw new ApiError(404, 'Schedule not found');
      schedules.splice(i, 1);
      return delay(undefined);
    },

    getSettings: () => delay({ ...settings }),
    patchSettings: async (b) => {
      settings = { ...settings, ...b };
      return delay({ ...settings });
    },

    getModels: () =>
      delay([
        { id: 'google/gemma-3-12b-it', label: 'Gemma 3 12B (default)' },
        { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
      ]),
    processAi: () => delay({ summarized: arts.filter((a) => a.tldr === null).length, flagged_political: 0, failed: 0, skipped_no_key: false }, 800),
    digestPreview: () => delay(nextBatch()),
    previewUrl: () => null,
    checkPreview: () => delay(undefined, 100),
    printNow: async () => {
      const items = nextBatch().map((d) => {
        const a = articles.find((x) => x.id === d.article_id);
        return { position: d.position, article_id: d.article_id, category_slug: d.category_slug, tldr: d.tldr, title: a?.title ?? null };
      });
      if (items.length === 0) throw new ApiError(409, 'Nothing new to print');
      const rec: PrintRecord = { id: nextIds.print++, created_at: new Date().toISOString(), trigger: 'manual', status: 'printed', error: null, items };
      prints.push(rec);
      return delay(clone(rec), 900);
    },
  };
}
