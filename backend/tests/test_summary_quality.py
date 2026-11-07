import json

import openai

from tnp.ai import clean_tldr, summarize, summarize_and_classify
from tnp.ai.clean import MAX_INPUT_CHARS, prepare_body, strip_boilerplate
from tnp.ai.summarize import (
    BANNED_PHRASES, COMBINED_SYSTEM_PROMPT, MAX_TLDR_CHARS, SUMMARY_SYSTEM_PROMPT, quality_issues,
)

from .test_ai import FakeClient, art

GOOD = ("Acme Corp launched the Zephyr 2 chip, which runs language models on-device at 40 tokens per second "
        "while drawing 3 watts. It ships to phone makers in March and doubles the speed of the earlier Zephyr "
        "design, which could bring offline assistants to mid-range handsets.")
LONG_BODY = "Acme details. " * 100


def test_strip_boilerplate_removes_known_lines():
    text = "\n".join([
        "Hi, this is Gergely with a bonus, free issue of the Pragmatic Engineer Newsletter.",
        "Subscribe",
        "Share",
        "Listen to the episode on Spotify",
        "Sponsored by Acme",
        "This post was originally published on example.com",
        "https://example.com/only-a-url",
        "Read more",
        "The real content starts here and it matters.",
        "Share prices of Acme rose 5 percent after the launch announcement today.",
    ])
    assert strip_boilerplate(text).splitlines() == [
        "The real content starts here and it matters.",
        "Share prices of Acme rose 5 percent after the launch announcement today.",
    ]


def test_strip_boilerplate_is_conservative():
    keep = "Hi there, this is a story about a dog who learned to surf in Hawaii last summer."
    assert strip_boilerplate(keep) == keep
    para = "Subscribers of the service will see prices rise by 10 percent starting next month, the company said."
    assert strip_boilerplate(para) == para


def test_prepare_body_budget_and_paragraph_cut():
    paras = "\n\n".join(f"Paragraph {i}. " + "word " * 100 for i in range(60))
    out = prepare_body(paras)
    assert len(out) <= MAX_INPUT_CHARS and out.startswith("Paragraph 0.")
    assert out.rstrip().endswith("word")
    assert prepare_body("Short text.") == "Short text."


def test_clean_tldr_new_cap():
    assert MAX_TLDR_CHARS == 450
    out = clean_tldr("Sentence number one is here. " * 40)
    assert len(out) <= 450 and out.endswith(".")
    assert clean_tldr(GOOD) == GOOD


def test_prompts_carry_the_descriptiveness_rules():
    for p in (SUMMARY_SYSTEM_PROMPT, COMBINED_SYSTEM_PROMPT):
        low = p.lower()
        assert "name the concrete subject" in low
        assert "numbers, names" in low and "why it matters" in low
        assert "45 to 70 words" in low and "450 characters" in low
        assert "never invent facts" in low
        assert "argument or finding" in low
        for phrase in BANNED_PHRASES:
            assert phrase in low or phrase.startswith("this ")
        assert "good examples" in low
    assert '"tldr"' in COMBINED_SYSTEM_PROMPT


def test_quality_issues():
    assert quality_issues(GOOD) == []
    assert "too short" in quality_issues("Acme ships a chip.")
    assert quality_issues("Acme ships a chip.", input_chars=100) == []  # teaser-only input: no padding demanded
    assert any("filler" in i for i in quality_issues(GOOD + " The post explores various ideas."))
    assert "question" in quality_issues(GOOD + " Why?")


def test_summarize_retries_once_on_vague_output():
    c = FakeClient(["Acme ships a chip.", GOOD])
    r = summarize(art(text=LONG_BODY), client=c, model="m")
    assert r.tldr == GOOD and len(c.calls) == 2
    assert "previous answer was too vague" in c.calls[1]["messages"][0]["content"]
    assert c.calls[1]["max_tokens"] == 220


def test_summarize_good_output_no_retry():
    c = FakeClient(GOOD)
    summarize(art(text=LONG_BODY), client=c, model="m")
    assert len(c.calls) == 1


def test_summarize_keeps_better_first_answer_if_retry_worse():
    c = FakeClient([GOOD + " It explores various themes.", "Short."])
    r = summarize(art(text=LONG_BODY), client=c, model="m")
    assert r.tldr.startswith("Acme Corp launched") and len(c.calls) == 2


def test_summarize_retry_error_keeps_first():
    c = FakeClient(["Acme ships a chip.", openai.APIConnectionError(request=None)])
    r = summarize(art(text=LONG_BODY), client=c, model="m")
    assert r.tldr == "Acme ships a chip."


def test_combined_retries_on_vague_output():
    bad = json.dumps({"political": False, "reason": "x", "tldr": "Acme ships a chip."})
    good = json.dumps({"political": False, "reason": "x", "tldr": GOOD})
    c = FakeClient([bad, good])
    s, v = summarize_and_classify(art(text=LONG_BODY), client=c, model="m")
    assert s.tldr == GOOD and not v.is_political and len(c.calls) == 2
