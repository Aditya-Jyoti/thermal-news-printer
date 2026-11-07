"""QA: TL;DR cleaning, politics parsing, fallback models, client construction. No network."""
from types import SimpleNamespace

import openai
import pytest
from openai import OpenAI

from tnp.ai import AIError, AIUnavailable, MAX_TLDR_CHARS, clean_tldr, make_client
from tnp.ai.client import chat, chat_with_fallback, try_models
from tnp.ai.politics import classify_politics, parse_verdict_json
from tnp.ai.summarize import summarize, summarize_and_classify
from tnp.models import ArticleForAI

PRIMARY = "google/gemma-3-12b-it"
FALLBACK = "deepseek/deepseek-v4.1-flash"


def _reply(text):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))])


class FakeClient:
    """`responder(model, kwargs)` returns text or raises. Records every model called."""

    def __init__(self, responder):
        self.responder = responder
        self.calls: list[str] = []
        self.kwargs: list[dict] = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **kw):
        self.calls.append(kw["model"])
        self.kwargs.append(kw)
        out = self.responder(kw["model"], kw)
        if isinstance(out, Exception):
            raise out
        return _reply(out)


def fail_on(*models, text="ok"):
    def responder(model, kw):
        if model in models:
            return openai.APIConnectionError(request=None)
        return text
    return responder


def art(**kw):
    base = dict(id=7, title="Lab cracks fusion ignition", url="https://ex.com/7",
                content_text="Researchers report net energy gain.", category_slug="engineering",
                published_at=None)
    base.update(kw)
    return ArticleForAI(**base)


# --- clean_tldr ----------------------------------------------------------------

@pytest.mark.parametrize(
    "raw,expected",
    [
        ("TL;DR: Apple ships the X.", "Apple ships the X."),
        ("TLDR - Apple ships the X.", "Apple ships the X."),
        ("Here's a TL;DR: Foo happens.", "Foo happens."),
        ("Here is the summary: Foo happens.", "Foo happens."),
        ("Summary: Foo happens.", "Foo happens."),
        ("**Bold** claim and *italic* word.", "Bold claim and italic word."),
        ("__under__ and ~~strike~~ and `code`.", "under and strike and code."),
        ("See [the paper](https://x.example/p) now.", "See the paper now."),
        ("![alt text](https://x.example/i.png) Caption.", "alt text Caption."),
        ("- first point", "first point"),
        ("1. numbered point", "numbered point"),
        ("# Heading\nBody text.", "Heading Body text."),
        ('"Quoted whole sentence."', "Quoted whole sentence."),
        ("“Curly quoted.”", "Curly quoted."),
        ("Launch today\U0001F680 ✨ now.", "Launch today now."),
        ("Line one.\n\nLine   two.", "Line one. Line two."),
        ("```\nFenced text.\n```", "Fenced text."),
        ("Price 5 * 3 is 15.", "Price 5 * 3 is 15."),
    ],
)
def test_clean_tldr_normalizes_model_output(raw, expected):
    assert clean_tldr(raw) == expected


def test_clean_tldr_empty_and_prefix_only():
    assert clean_tldr("") == ""
    assert clean_tldr("   ") == ""
    assert clean_tldr("TL;DR:") == ""


def test_clean_tldr_keeps_inner_quotes_and_never_exceeds_cap():
    assert clean_tldr('He said "yes" today.') == 'He said "yes" today.'
    long = "word " * 200
    assert len(clean_tldr(long)) <= MAX_TLDR_CHARS


def test_clean_tldr_cuts_at_sentence_boundary_when_late_enough():
    text = "A" * 250 + ". " + "b " * 200
    out = clean_tldr(text)
    assert out == "A" * 250 + "."


def test_clean_tldr_cuts_at_word_boundary_with_ellipsis():
    out = clean_tldr("word " * 100)
    assert out.endswith("…") and len(out) <= MAX_TLDR_CHARS
    body = out[:-1]
    assert body.split(" ") == ["word"] * len(body.split(" "))  # no half-word


def test_clean_tldr_hard_cut_when_no_space_or_sentence():
    out = clean_tldr("x" * 1000)
    assert len(out) == MAX_TLDR_CHARS and out.endswith("…")


def test_clean_tldr_custom_cap():
    assert len(clean_tldr("a" * 50 + " " + "b" * 50, max_chars=40)) <= 40


# --- politics parsing ----------------------------------------------------------

@pytest.mark.parametrize(
    "raw,flag,reason",
    [
        ('{"political": true, "reason": "election coverage"}', True, "election coverage"),
        ('```json\n{"political": false, "reason": "product launch"}\n```', False, "product launch"),
        ('{"is_political": true}', True, None),
        ('{"political": "false"}', False, None),
        ('{"political": "yes"}', True, None),
        ('{"political": 0}', False, None),
        ('Political: yes', True, None),
        ('"political": true, but truncated', True, None),
        ("false", False, None),
        ("Yes.", True, None),
    ],
)
def test_parse_verdict_variants(raw, flag, reason):
    v = parse_verdict_json(raw, 3)
    assert (v.article_id, v.is_political) == (3, flag)
    assert v.reason == reason


@pytest.mark.parametrize("raw", ["", "I cannot decide.", "{}", "{\"political\": null}"])
def test_unparseable_verdict_defaults_to_not_political(raw):
    v = parse_verdict_json(raw, 9)
    assert v.is_political is False and v.reason == "unparsed"


def test_reason_is_truncated():
    v = parse_verdict_json('{"political": false, "reason": "%s"}' % ("z" * 500), 1)
    assert len(v.reason) == 200


# --- client & fallback ---------------------------------------------------------

def test_make_client_without_key_is_unavailable():
    with pytest.raises(AIUnavailable):
        make_client()


def test_make_client_with_key_uses_openrouter_base_url(monkeypatch):
    monkeypatch.delenv("OPENROUTER_BASE_URL", raising=False)
    c = make_client("sk-test")
    assert isinstance(c, OpenAI)
    assert str(c.base_url).rstrip("/") == "https://openrouter.ai/api/v1"


def test_chat_empty_or_null_content_raises():
    for content in (None, "   "):
        fake = FakeClient(lambda m, kw, c=content: c)
        with pytest.raises(AIError):
            chat(fake, model=PRIMARY, system="s", user="u")


def test_chat_api_error_wrapped_as_ai_error():
    fake = FakeClient(lambda m, kw: openai.APIConnectionError(request=None))
    with pytest.raises(AIError):
        chat(fake, model=PRIMARY, system="s", user="u")


def test_chat_sends_single_user_message_with_system_text():
    fake = FakeClient(lambda m, kw: "hi")
    chat(fake, model=PRIMARY, system="SYS", user="USR", max_tokens=42)
    msg = fake.kwargs[0]["messages"]
    assert len(msg) == 1 and msg[0]["role"] == "user"
    assert msg[0]["content"].startswith("SYS") and msg[0]["content"].endswith("USR")
    assert fake.kwargs[0]["max_tokens"] == 42


def test_try_models_dedupes_and_skips_blank():
    seen = []

    def attempt(m):
        seen.append(m)
        raise AIError("nope")

    with pytest.raises(AIError):
        try_models([PRIMARY, "", PRIMARY, FALLBACK], attempt)
    assert seen == [PRIMARY, FALLBACK]


def test_try_models_no_models_raises():
    with pytest.raises(AIError, match="no model"):
        try_models(["", None], lambda m: m)


def test_try_models_unavailable_is_not_retried_on_fallback():
    seen = []

    def attempt(m):
        seen.append(m)
        raise AIUnavailable("no key")

    with pytest.raises(AIUnavailable):
        try_models([PRIMARY, FALLBACK], attempt)
    assert seen == [PRIMARY]


def test_chat_with_fallback_returns_answering_model():
    fake = FakeClient(fail_on(PRIMARY, text="fallback says hi"))
    text, model = chat_with_fallback(fake, models=[PRIMARY, FALLBACK], system="s", user="u")
    assert (text, model) == ("fallback says hi", FALLBACK)


# --- summarize -----------------------------------------------------------------

def test_summarize_cleans_and_records_primary_model():
    fake = FakeClient(lambda m, kw: "TL;DR: Lab reports net energy gain.")
    r = summarize(art(), client=fake, model=PRIMARY, fallback_model=FALLBACK)
    assert r.tldr == "Lab reports net energy gain." and r.model == PRIMARY
    assert r.article_id == 7 and fake.calls == [PRIMARY]


def test_summarize_falls_back_when_primary_raises_and_records_fallback():
    fake = FakeClient(fail_on(PRIMARY, text="Fallback summary."))
    r = summarize(art(), client=fake, model=PRIMARY, fallback_model=FALLBACK)
    assert r.model == FALLBACK and r.tldr == "Fallback summary."
    assert fake.calls == [PRIMARY, FALLBACK]


def test_summarize_falls_back_when_primary_output_unusable():
    fake = FakeClient(lambda m, kw: "TL;DR:" if m == PRIMARY else "Usable text.")
    r = summarize(art(), client=fake, model=PRIMARY, fallback_model=FALLBACK)
    assert r.model == FALLBACK


def test_summarize_no_fallback_and_both_fail_raise():
    fake = FakeClient(fail_on(PRIMARY))
    with pytest.raises(AIError):
        summarize(art(), client=fake, model=PRIMARY, fallback_model=None)
    fake = FakeClient(fail_on(PRIMARY, FALLBACK))
    with pytest.raises(AIError):
        summarize(art(), client=fake, model=PRIMARY, fallback_model=FALLBACK)
    assert fake.calls == [PRIMARY, FALLBACK]


def test_summarize_without_content_still_calls_model_with_headline():
    fake = FakeClient(lambda m, kw: "Headline-only blurb.")
    summarize(art(content_text=None), client=fake, model=PRIMARY)
    assert "Headline: Lab cracks fusion ignition" in fake.kwargs[0]["messages"][0]["content"]


# --- combined summary + politics -----------------------------------------------

def test_summarize_and_classify_combined_json():
    fake = FakeClient(lambda m, kw: '{"political": true, "reason": "war", "tldr": "Talks stall again."}')
    s, v = summarize_and_classify(art(), client=fake, model=PRIMARY)
    assert s.tldr == "Talks stall again." and s.model == PRIMARY
    assert v.is_political is True and v.reason == "war"


def test_summarize_and_classify_falls_back_on_bad_json_and_records_model():
    def responder(m, kw):
        if m == PRIMARY:
            return "not json at all"
        return '{"political": false, "reason": "ok", "tldr": "Good news."}'

    fake = FakeClient(responder)
    s, v = summarize_and_classify(art(), client=fake, model=PRIMARY, fallback_model=FALLBACK)
    assert s.model == FALLBACK and s.tldr == "Good news." and v.is_political is False


def test_summarize_and_classify_missing_tldr_fails_without_fallback():
    fake = FakeClient(lambda m, kw: '{"political": false, "reason": "x"}')
    with pytest.raises(AIError):
        summarize_and_classify(art(), client=fake, model=PRIMARY, fallback_model=None)


def test_classify_politics_uses_fallback_and_parses():
    fake = FakeClient(fail_on(PRIMARY, text='{"political": true, "reason": "policy"}'))
    v = classify_politics(art(), client=fake, model=PRIMARY, fallback_model=FALLBACK)
    assert v.is_political is True and v.article_id == 7
    assert fake.calls == [PRIMARY, FALLBACK]
    assert fake.kwargs[-1]["temperature"] == 0.0
