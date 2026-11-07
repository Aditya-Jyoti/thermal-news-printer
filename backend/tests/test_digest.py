from datetime import datetime, timedelta, timezone

from tnp.digest import is_near_duplicate, jaccard, normalize_title, select_digest, title_tokens
from tnp.models import DigestCandidate

BASE = datetime(2026, 1, 1, tzinfo=timezone.utc)


def cand(i, cat, title=None, age=0, tldr=None):
    return DigestCandidate(
        article_id=i, title=title or f"Unique story number {i} about {cat}{i * 7}",
        category_slug=cat, tldr=tldr or f"tldr {i}", published_at=BASE - timedelta(hours=age),
    )


def run(cands, **kw):
    args = dict(limits={"a": 2, "b": 2}, max_total=10, printed_ids=set(), last_print_titles=[])
    args.update(kw)
    return select_digest(cands, **args)


def test_normalize_and_jaccard():
    assert normalize_title("  Héllo, World!! ") == "hello world"
    assert jaccard(title_tokens("a b c d"), title_tokens("a b c d")) == 1.0
    assert jaccard(title_tokens("a b"), title_tokens("c d")) == 0.0
    assert is_near_duplicate("Apple launches new phone", "Apple Launches New Phone!")


def test_category_limits_and_default():
    cands = [cand(i, "a", age=i) for i in range(1, 6)] + [cand(i, "z", age=i) for i in range(10, 15)]
    out = run(cands, limits={"a": 3})
    assert [i.category_slug for i in out].count("a") == 3
    assert [i.category_slug for i in out].count("z") == 2  # default 2


def test_limit_zero_skips_category():
    out = run([cand(1, "a"), cand(2, "b")], limits={"a": 0, "b": 2})
    assert [i.article_id for i in out] == [2]


def test_max_total_and_positions():
    cands = [cand(i, "a", age=i) for i in range(1, 5)] + [cand(i, "b", age=i) for i in range(11, 15)]
    out = run(cands, limits={"a": 4, "b": 4}, max_total=3)
    assert len(out) == 3
    assert [i.position for i in out] == [1, 2, 3]


def test_excludes_printed_ids():
    out = run([cand(1, "a"), cand(2, "a")], printed_ids={1})
    assert [i.article_id for i in out] == [2]


def test_near_duplicate_vs_last_print():
    c = [cand(1, "a", title="OpenAI releases brand new model today"), cand(2, "a", title="Totally different thing here")]
    out = run(c, last_print_titles=["OpenAI releases brand new model today!"])
    assert [i.article_id for i in out] == [2]


def test_near_duplicate_within_batch_across_categories():
    c = [
        cand(1, "a", title="Startup raises big seed round for robots", age=1),
        cand(2, "b", title="Startup raises big seed round for robots", age=0),
    ]
    out = run(c)
    assert [i.article_id for i in out] == [1]


def test_duplicate_skipped_next_in_category_used():
    c = [
        cand(1, "a", title="Same headline words here ok", age=0),
        cand(2, "a", title="Same headline words here ok", age=1),
        cand(3, "a", title="Another distinct headline entirely", age=2),
    ]
    out = run(c, limits={"a": 2})
    assert [i.article_id for i in out] == [1, 3]


def test_round_robin_and_category_order():
    c = [cand(1, "a", age=0), cand(2, "a", age=1), cand(3, "b", age=2), cand(4, "b", age=3), cand(5, "c", age=4)]
    out = run(c, limits={"b": 2, "a": 2})
    # limits order first (b, a), then others alphabetically (c); newest first within category
    assert [i.article_id for i in out] == [3, 1, 5, 4, 2]


def test_newest_first_with_undated_last():
    undated = DigestCandidate(article_id=9, title="undated distinct piece", category_slug="a", tldr="x", published_at=None)
    out = run([undated, cand(1, "a", age=5), cand(2, "a", age=1)], limits={"a": 3})
    assert [i.article_id for i in out] == [2, 1, 9]


def test_deterministic_regardless_of_input_order():
    c = [cand(i, "a" if i % 2 else "b", age=i) for i in range(1, 10)]
    assert run(c) == run(list(reversed(c)))
    assert run(c) == run(c)


def test_empty():
    assert run([]) == []
