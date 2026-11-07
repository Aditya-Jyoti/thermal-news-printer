"""QA: pure print-batch selection (select_digest) and title similarity rules."""
from datetime import datetime, timedelta, timezone

import pytest

from tnp.digest import select_digest
from tnp.digest.similarity import NEAR_DUPLICATE_THRESHOLD, is_near_duplicate, jaccard, normalize_title, title_tokens
from tnp.models import DigestCandidate

NOW = datetime(2026, 11, 7, 12, 0, tzinfo=timezone.utc)
LIMITS = {"products": 2, "engineering": 2, "psychology": 2, "learning": 2}


def cand(aid, slug="products", title=None, days_ago=0, undated=False):
    return DigestCandidate(
        article_id=aid,
        title=title or f"Zebra{aid} quokka{aid} wombat{aid} story",
        category_slug=slug,
        tldr=f"tldr {aid}",
        published_at=None if undated else NOW - timedelta(days=days_ago, minutes=aid),
    )


def pick(candidates, *, limits=LIMITS, max_total=8, printed=frozenset(), last=()):
    return select_digest(
        candidates, limits=dict(limits), max_total=max_total,
        printed_ids=set(printed), last_print_titles=list(last),
    )


def ids(items):
    return [i.article_id for i in items]


# --- similarity rules ----------------------------------------------------------

def test_normalize_title_folds_case_accents_and_punctuation():
    assert normalize_title("Café  Launches!!  NEW-Phone") == "cafe launches new phone"
    assert title_tokens("Café, launches & more") == title_tokens("cafe launches MORE")


def test_jaccard_edge_cases():
    assert jaccard(set(), set()) == 1.0
    assert jaccard({"a"}, set()) == 0.0
    assert jaccard({"a", "b"}, {"a", "b"}) == 1.0


def test_threshold_boundary_is_inclusive_at_0_8():
    assert NEAR_DUPLICATE_THRESHOLD == 0.8
    base = "alpha beta gamma delta"
    assert jaccard(title_tokens(base), title_tokens(base + " epsilon")) == pytest.approx(0.8)
    assert is_near_duplicate(base, base + " epsilon")  # 4/5 == 0.8 -> duplicate


def test_just_below_threshold_is_not_duplicate():
    a = "one two three four five six seven eight"
    b = "one two three four five six seven nine"  # 7/9 = 0.777...
    assert jaccard(title_tokens(a), title_tokens(b)) < 0.8
    assert not is_near_duplicate(a, b)
    assert not is_near_duplicate("alpha beta gamma delta", "alpha beta gamma zeta")  # 3/5


def test_punctuation_and_case_only_difference_is_duplicate():
    assert is_near_duplicate("Alpha, Beta & Gamma!", "alpha beta gamma")


# --- selection: dedup ----------------------------------------------------------

def test_printed_ids_never_selected():
    out = pick([cand(1), cand(2)], printed={1})
    assert ids(out) == [2]


def test_duplicate_candidate_rows_selected_once():
    out = pick([cand(1), cand(1), cand(2)])
    assert sorted(ids(out)) == [1, 2]


def test_near_duplicate_of_last_print_is_excluded_and_next_used():
    last = ["Zebra quokka wombat story recap"]
    c1 = cand(1, title="Zebra quokka wombat story recap today")  # 5/6 = 0.83 >= 0.8 -> excluded
    c2 = cand(2, title="Completely different subject matter entirely")
    out = pick([c1, c2], last=last, limits={"products": 2})
    assert ids(out) == [2]


def test_near_duplicate_within_same_batch_excluded_across_categories():
    a = cand(1, "products", title="Apple unveils new foldable phone design")
    b = cand(2, "engineering", title="Apple unveils new foldable phone design today!")
    out = pick([a, b])
    assert ids(out) == [1]


def test_distinct_titles_both_selected_across_categories():
    a = cand(1, "products", title="Apple unveils foldable phone")
    b = cand(2, "engineering", title="Postgres 18 improves vacuum throughput")
    assert sorted(ids(pick([a, b]))) == [1, 2]


def test_last_print_title_threshold_boundary_in_selection():
    last = ["alpha beta gamma delta"]
    at_threshold = cand(1, title="alpha beta gamma delta epsilon")  # 0.8 -> excluded
    below = cand(2, title="alpha beta gamma zeta")  # 0.6 -> kept
    assert ids(pick([at_threshold, below], last=last)) == [2]


# --- selection: limits & ordering ----------------------------------------------

def test_category_limit_zero_excludes_category_entirely():
    out = pick([cand(1, "products"), cand(2, "psychology")], limits={"products": 0, "psychology": 2})
    assert ids(out) == [2]


def test_negative_limit_also_excludes():
    assert ids(pick([cand(1, "products")], limits={"products": -1})) == []


def test_per_category_cap_respected_newest_first():
    cands = [cand(i, "products", title=f"Unique{i} subject{i} matter{i} here{i}", days_ago=i) for i in range(1, 6)]
    out = pick(cands, limits={"products": 3})
    assert ids(out) == [1, 2, 3]  # article 1 is the newest (smallest days_ago)


def test_max_total_caps_batch_and_positions_are_contiguous():
    cands = [cand(i, slug, title=f"T{i} foo{i} bar{i} qux{i}")
             for i, slug in enumerate(["products"] * 2 + ["engineering"] * 2 + ["psychology"] * 2 + ["learning"] * 2, 1)]
    out = pick(cands, max_total=3)
    assert len(out) == 3
    assert [i.position for i in out] == [1, 2, 3]


def test_round_robin_interleaves_categories_in_limit_order():
    cands = [
        cand(1, "products", days_ago=0), cand(2, "products", days_ago=1), cand(3, "products", days_ago=2),
        cand(4, "engineering", days_ago=0), cand(5, "psychology", days_ago=0),
    ]
    limits = {"products": 3, "engineering": 1, "psychology": 1}
    out = pick(cands, limits=limits, max_total=4)
    assert [i.category_slug for i in out] == ["products", "engineering", "psychology", "products"]
    assert ids(out) == [1, 4, 5, 2]


def test_category_not_in_limits_gets_default_cap_of_two_and_sorts_last():
    cands = [cand(1, "mystery", title="Mystery one alpha"), cand(2, "mystery", title="Mystery two beta"),
             cand(3, "mystery", title="Mystery three gamma"), cand(4, "products", title="Products news delta")]
    out = pick(cands, limits={"products": 1})
    assert [i.category_slug for i in out] == ["products", "mystery", "mystery"]


def test_newest_first_with_undated_last_then_id_desc():
    cands = [cand(1, days_ago=5), cand(2, undated=True), cand(3, days_ago=0), cand(4, undated=True)]
    out = pick(cands, limits={"products": 4}, max_total=8)
    assert ids(out) == [3, 1, 4, 2]


def test_naive_datetimes_are_treated_as_utc():
    aware = cand(1, days_ago=0)
    naive = DigestCandidate(article_id=2, title="Naive stamp story", category_slug="products",
                            tldr="t", published_at=datetime(2026, 11, 7, 11, 0))
    out = pick([naive, aware], limits={"products": 2})
    assert ids(out) == [1, 2]  # aware 12:00 - 1min is newer than naive 11:00 UTC


def test_empty_inputs():
    assert pick([]) == []
    assert pick([cand(1)], max_total=0) == []


def test_output_is_deterministic_regardless_of_input_order():
    cands = [cand(i, slug, title=f"Item{i} thing{i} other{i} words{i}") for i, slug in
             [(1, "products"), (2, "engineering"), (3, "products"), (4, "psychology")]]
    a = pick(cands)
    b = pick(list(reversed(cands)))
    assert [(i.article_id, i.position, i.category_slug) for i in a] == [(i.article_id, i.position, i.category_slug) for i in b]


def test_digest_item_carries_tldr_and_category():
    out = pick([cand(9, "learning", title="Learning unique words here")])
    assert out[0].tldr == "tldr 9" and out[0].category_slug == "learning"
