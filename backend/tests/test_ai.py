from types import SimpleNamespace

import openai
import pytest

from tnp.ai import (
    AIError, AIUnavailable, classify_politics, clean_tldr, make_client,
    summarize, summarize_and_classify, summarize_many,
)
from tnp.ai.politics import parse_verdict_json
from tnp.models import ArticleForAI


class FakeClient:
    """Mimics client.chat.completions.create; `replies` items are str or Exception."""

    def __init__(self, replies):
        self.replies = list(replies) if isinstance(replies, list) else None
        self.fixed = replies if not isinstance(replies, list) else None
        self.calls = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **kw):
        self.calls.append(kw)
        r = self.replies.pop(0) if self.replies is not None else self.fixed
        if isinstance(r, Exception):
            raise r
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=r))])


def art(i=1, text="Body text.", title="Some Title"):
    return ArticleForAI(id=i, title=title, url="http://x", content_text=text, category_slug="c", published_at=None)


def test_missing_key(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    with pytest.raises(AIUnavailable):
        make_client()


def test_make_client_config(monkeypatch):
    monkeypatch.delenv("OPENROUTER_BASE_URL", raising=False)
    c = make_client(api_key="k")
    assert str(c.base_url).startswith("https://openrouter.ai/api/v1")
    assert c.max_retries > 0


def test_clean_strips_prefix_markdown_quotes():
    assert clean_tldr('TL;DR: "**Acme** launched a *new* chip."') == "Acme launched a new chip."
    assert clean_tldr("Here's a TL;DR of the article:\n\n- Acme shipped it. 🚀") == "Acme shipped it."
    assert clean_tldr("  a \n\n b\t c ") == "a b c"


def test_clean_enforces_length_at_sentence():
    text = "A fairly long first sentence that fills a good part of the budget. " * 3 + "word " * 100
    out = clean_tldr(text, 280)
    assert len(out) <= 280 and out.endswith(".")


def test_clean_enforces_length_at_word_boundary():
    out = clean_tldr("word " * 200, 280)
    assert len(out) <= 280 and out.endswith("…") and "wor…" not in out


def test_summarize_ok_and_truncates_input():
    c = FakeClient("TL;DR: Acme ships a chip.")
    r = summarize(art(text="x " * 20000), client=c, model="m")
    assert r.tldr == "Acme ships a chip." and r.article_id == 1 and r.model == "m"
    assert len(c.calls[0]["messages"][0]["content"]) < 8000


def test_summarize_empty_content_uses_title():
    c = FakeClient("Something happened.")
    summarize(art(text=None, title="Big Headline"), client=c, model="m")
    sent = c.calls[0]["messages"][0]["content"]
    assert "Big Headline" in sent and "No article text" in sent


def test_summarize_many_skips_failures_keeps_order():
    class Mixed(FakeClient):
        def _create(self, **kw):
            if "boom" in kw["messages"][0]["content"]:
                raise openai.APIConnectionError(request=None)
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="ok"))])

    c = Mixed("")
    c.chat = SimpleNamespace(completions=SimpleNamespace(create=c._create))
    res = summarize_many([art(1), art(2, text="boom"), art(3)], client=c, model="m", concurrency=2)
    assert [r.article_id for r in res] == [1, 3]


def test_empty_response_raises():
    with pytest.raises(AIError):
        summarize(art(), client=FakeClient("   "), model="m")


@pytest.mark.parametrize("raw,expected", [
    ('{"political": true, "reason": "election"}', True),
    ('```json\n{"political": false, "reason": "chip launch"}\n```', False),
    ('Sure! {"political": "yes", "reason": "x"}', True),
    ('political: false', False),
    ('True', True),
])
def test_parse_verdict(raw, expected):
    assert parse_verdict_json(raw, 5).is_political is expected


def test_parse_verdict_garbage_defaults_false():
    v = parse_verdict_json("I cannot say.", 5)
    assert v.is_political is False and v.reason == "unparsed" and v.article_id == 5


def test_classify_politics():
    v = classify_politics(art(), client=FakeClient('{"political": true, "reason": "senate bill"}'), model="m")
    assert v.is_political and v.reason == "senate bill"


def test_summarize_and_classify():
    raw = '{"political": false, "reason": "product", "tldr": "**Acme** unveiled a chip."}'
    s, v = summarize_and_classify(art(), client=FakeClient(raw), model="m")
    assert s.tldr == "Acme unveiled a chip." and v.is_political is False


def test_summarize_and_classify_bad_json_raises():
    with pytest.raises(AIError):
        summarize_and_classify(art(), client=FakeClient("no json"), model="m")


def test_summarize_falls_back_and_records_model():
    c = FakeClient([openai.APIConnectionError(request=None), "Acme ships a chip."])
    r = summarize(art(), client=c, model="primary", fallback_model="backup")
    assert r.model == "backup" and [k["model"] for k in c.calls] == ["primary", "backup"]


def test_summarize_no_fallback_raises_and_primary_ok_skips_fallback():
    with pytest.raises(AIError):
        summarize(art(), client=FakeClient([openai.APIConnectionError(request=None)]), model="p")
    c = FakeClient("Fine.")
    assert summarize(art(), client=c, model="p", fallback_model="b").model == "p"
    assert len(c.calls) == 1


def test_combined_falls_back_on_unusable_reply():
    good = '{"political": false, "reason": "x", "tldr": "Acme ships a chip."}'
    c = FakeClient(["garbage", good])
    s, v = summarize_and_classify(art(), client=c, model="p", fallback_model="b")
    assert s.model == "b" and not v.is_political
