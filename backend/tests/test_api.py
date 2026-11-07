import pytest
from fastapi.testclient import TestClient

from tnp.api.app import create_app
from tnp.api.cron import validate_cron


@pytest.fixture
def client(tmp_path):
    return TestClient(create_app(str(tmp_path / "api.sqlite3")))


def test_cron():
    assert validate_cron("*/15 8-18 * * 1-5") == "*/15 8-18 * * 1-5"
    for bad in ("* * * *", "61 * * * *", "a * * * *", "* 24 * * *", "*/0 * * * *"):
        with pytest.raises(ValueError):
            validate_cron(bad)


def test_health_and_seed(client):
    assert client.get("/health").json() == {"status": "ok"}
    cats = client.get("/categories").json()
    assert [c["slug"] for c in cats] == ["products", "engineering", "psychology", "learning"]
    assert cats[0]["feed_count"] == 2
    assert client.get("/settings").json()["max_items_total"] == 8
    assert client.get("/schedules").json()[0]["cron"] == "0 8 * * *"


def test_category_feed_crud(client):
    c = client.post("/categories", json={"name": "Science"})
    assert c.status_code == 201 and c.json()["slug"] == "science"
    assert client.post("/categories", json={"name": "Science"}).status_code == 409
    cid = c.json()["id"]
    assert client.patch(f"/categories/{cid}", json={"print_limit": 5}).json()["print_limit"] == 5
    f = client.post("/feeds", json={"url": "https://x.test/rss", "category_id": cid})
    assert f.status_code == 201
    assert client.post("/feeds", json={"url": "nope", "category_id": cid}).status_code == 422
    assert client.post("/feeds", json={"url": "https://y.test", "category_id": 999}).status_code == 404
    assert len(client.get("/feeds", params={"category_id": cid}).json()) == 1
    assert client.delete(f"/categories/{cid}").status_code == 204
    assert client.get("/feeds", params={"category_id": cid}).json() == []


def test_schedules_settings_and_stubs(client):
    assert client.post("/schedules", json={"cron": "bad"}).status_code == 422
    s = client.post("/schedules", json={"cron": "0 18 * * *", "label": "Evening"})
    assert s.status_code == 201
    sid = s.json()["id"]
    assert client.patch(f"/schedules/{sid}", json={"enabled": False}).json()["enabled"] is False
    assert client.delete(f"/schedules/{sid}").status_code == 204
    assert client.patch("/settings", json={"max_items_total": 5}).json()["max_items_total"] == 5
    assert client.patch("/settings", json={"max_items_total": 99}).status_code == 422
    assert client.get("/articles").json() == {"items": [], "total": 0, "limit": 50, "offset": 0}
    assert client.get("/articles/1").status_code == 404
    assert client.get("/prints").json()["total"] == 0
    for method, path in (("get", "/digest/preview"), ("get", "/print/preview.png"), ("post", "/print")):
        assert getattr(client, method)(path).status_code == 501
