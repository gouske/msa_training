"""[제24강 Phase 2] Payment Service 메트릭 모듈 테스트.

Phase 1 (Order/Node) 의 테스트 커버리지를 그대로 따른다:
    1. /metrics 가 Prometheus exposition 형식으로 응답
    2. 카운터 누적 + 라우트 라벨 정규화
    3. /metrics self-scrape 는 카운터에서 제외
    4. service_dependency_ready Gauge 의 set_ready 동작
    5. 핸들러 예외 시 status_code='0' 라벨링
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from prometheus_client import CollectorRegistry

from infrastructure.metrics import create_metrics


def _new_app(registry: CollectorRegistry):
    app = FastAPI()
    metrics = create_metrics(
        registry=registry,
        service_name="payment-service-test",
        metrics_path="/api/payment/metrics",
    )
    metrics.install(app)

    # 정적 라우트는 동적(`{order_id}`) 보다 먼저 등록 — FastAPI 는 등록 순서대로 매칭한다.
    @app.get("/api/payment/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.get("/api/payment/explode")
    def explode() -> dict:
        raise RuntimeError("boom")

    @app.get("/api/payment/forbidden")
    def forbidden() -> dict:
        raise HTTPException(status_code=403, detail="nope")

    @app.get("/api/payment/{order_id}")
    def get_payment(order_id: str) -> dict:
        return {"orderId": order_id}

    return app, metrics


def _exposition(metrics) -> str:
    from prometheus_client import generate_latest

    return generate_latest(metrics.registry).decode("utf-8")


def test_metrics_endpoint_returns_prometheus_exposition_format() -> None:
    registry = CollectorRegistry()
    app, _ = _new_app(registry)
    client = TestClient(app)

    response = client.get("/api/payment/metrics")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    body = response.text
    assert "http_requests_total" in body
    assert "http_request_duration_seconds" in body


def test_counter_increments_per_request() -> None:
    registry = CollectorRegistry()
    app, metrics = _new_app(registry)
    client = TestClient(app)

    client.get("/api/payment/health")
    client.get("/api/payment/health")
    client.get("/api/payment/health")

    body = _exposition(metrics)
    assert 'http_requests_total{method="GET",route="/api/payment/health",status_code="200"} 3.0' in body


def test_route_label_normalized_to_pattern_for_path_parameters() -> None:
    """파라미터화된 라우트는 매칭 패턴(/api/payment/{order_id}) 으로 정규화 — 카디널리티 안전."""
    registry = CollectorRegistry()
    app, metrics = _new_app(registry)
    client = TestClient(app)

    client.get("/api/payment/abc")
    client.get("/api/payment/xyz")

    body = _exposition(metrics)
    assert 'route="/api/payment/{order_id}"' in body
    # raw 경로가 라벨로 새지 않아야 한다.
    assert 'route="/api/payment/abc"' not in body
    assert 'route="/api/payment/xyz"' not in body


def test_metrics_endpoint_itself_is_excluded_from_counter() -> None:
    """관측 부트스트랩 루프 방지 — Prometheus scrape 가 자기 자신을 카운트하지 않음."""
    registry = CollectorRegistry()
    app, metrics = _new_app(registry)
    client = TestClient(app)

    client.get("/api/payment/metrics")
    client.get("/api/payment/metrics")

    body = _exposition(metrics)
    assert 'route="/api/payment/metrics"' not in body


def test_dependency_gauge_set_ready_toggles_value() -> None:
    """[Codex finding #2 패턴] DB/RabbitMQ 등 외부 의존성 진짜 가용성 gauge."""
    registry = CollectorRegistry()
    _, metrics = _new_app(registry)

    metrics.dependencies.set_ready("rabbitmq", True)
    body = _exposition(metrics)
    assert 'service_dependency_ready{dependency="rabbitmq"} 1.0' in body

    metrics.dependencies.set_ready("rabbitmq", False)
    body = _exposition(metrics)
    assert 'service_dependency_ready{dependency="rabbitmq"} 0.0' in body


def test_handler_exception_records_status_code_zero() -> None:
    """[Codex finding #3 패턴] 핸들러 예외로 응답이 정상 송신되지 않은 경우 status_code='0' 라벨링."""
    registry = CollectorRegistry()
    app, metrics = _new_app(registry)
    # raise_server_exceptions=False 로 둬야 미들웨어가 finally 블록을 실행한 뒤
    # 에러를 그대로 받아서 처리할 수 있다.
    client = TestClient(app, raise_server_exceptions=False)

    client.get("/api/payment/explode")

    body = _exposition(metrics)
    assert 'route="/api/payment/explode"' in body
    assert 'status_code="0"' in body


def test_http_exception_records_actual_status_code() -> None:
    """HTTPException 같이 정상적으로 직렬화된 응답은 그대로의 status_code 가 라벨링된다."""
    registry = CollectorRegistry()
    app, metrics = _new_app(registry)
    client = TestClient(app)

    client.get("/api/payment/forbidden")

    body = _exposition(metrics)
    assert 'http_requests_total{method="GET",route="/api/payment/forbidden",status_code="403"} 1.0' in body
