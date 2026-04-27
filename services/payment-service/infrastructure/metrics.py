"""[제24강 Phase 2] Prometheus 메트릭 — Payment Service.

Phase 1 (Order Service) 의 패턴을 그대로 가져와 4 서비스 라벨/메트릭 의미를 통일한다.
공통 약속:
    - http_requests_total{method, route, status_code} : RED 의 Rate + Errors
    - http_request_duration_seconds_bucket{method, route} : RED 의 Duration
    - service_dependency_ready{dependency} : 외부 의존성 진짜 가용성 (up 메트릭과 분리)

설계 원칙 (Phase 1 Codex review 반영):
    1. route 라벨은 FastAPI 매칭 패턴(/api/payment/{order_id}) 으로 정규화 — raw URL 노출 차단.
    2. /metrics self-scrape 는 카운터/히스토그램에서 자동 제외 — 부트스트랩 루프 방지.
    3. response.status_code 는 응답이 정상 send 되어야만 라벨에 사용,
       middleware 가 예외를 받으면 status_code='0' 으로 라벨링 (aborted/실패 분리).
"""

from __future__ import annotations

import time
from typing import Callable

from fastapi import FastAPI, Request, Response
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import PlainTextResponse


# ---------------------------------------------------------------------------
# 공개 API
# ---------------------------------------------------------------------------


class PaymentMetrics:
    """라우터 등록 + dependencies 핸들 묶음.

    테스트는 별도 ``CollectorRegistry`` 를 주입해 격리할 수 있다.
    운영은 기본 registry 를 사용해 prometheus_client 의 전역 동작과 호환.
    """

    def __init__(
        self,
        registry: CollectorRegistry | None = None,
        service_name: str = "payment-service",
        metrics_path: str = "/api/payment/metrics",
    ) -> None:
        self._registry = registry or CollectorRegistry()
        self._metrics_path = metrics_path
        self.service_name = service_name

        self.http_requests_total = Counter(
            "http_requests_total",
            "HTTP 요청 총 수 (route 는 FastAPI 매칭 패턴으로 정규화)",
            labelnames=("method", "route", "status_code"),
            registry=self._registry,
        )
        self.http_request_duration_seconds = Histogram(
            "http_request_duration_seconds",
            "HTTP 요청 처리 시간 (초)",
            labelnames=("method", "route"),
            buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10),
            registry=self._registry,
        )
        self._dependency_ready = Gauge(
            "service_dependency_ready",
            "외부 의존성 연결 가용성 (1=ready, 0=not ready)",
            labelnames=("dependency",),
            registry=self._registry,
        )

        self.dependencies = _Dependencies(self._dependency_ready)

    @property
    def registry(self) -> CollectorRegistry:
        return self._registry

    def _resolve_route_label(self, request: Request) -> str:
        """FastAPI 매칭 패턴을 라벨로 사용 — raw URL 노출 차단."""
        route = request.scope.get("route")
        if route is not None and getattr(route, "path", None):
            return route.path
        return "unmatched"

    def install(self, app: FastAPI) -> None:
        """FastAPI 앱에 미들웨어 + /metrics 라우트를 등록한다."""

        registry_ref = self._registry
        metrics_path = self._metrics_path
        counter = self.http_requests_total
        histogram = self.http_request_duration_seconds
        resolve_route = self._resolve_route_label

        class _MetricsMiddleware(BaseHTTPMiddleware):
            async def dispatch(self, request: Request, call_next):
                # /metrics self-scrape 는 카운트하지 않는다 (관측 부트스트랩 루프 방지).
                if request.url.path == metrics_path:
                    return await call_next(request)

                start = time.perf_counter()
                status_code = "0"
                response: Response | None = None
                try:
                    response = await call_next(request)
                    status_code = str(response.status_code)
                    return response
                except Exception:
                    # 핸들러가 예외를 던져 응답이 정상 송신되지 않은 케이스.
                    status_code = "0"
                    raise
                finally:
                    route_label = resolve_route(request)
                    counter.labels(
                        method=request.method,
                        route=route_label,
                        status_code=status_code,
                    ).inc()
                    histogram.labels(
                        method=request.method,
                        route=route_label,
                    ).observe(time.perf_counter() - start)

        app.add_middleware(_MetricsMiddleware)

        async def _metrics_handler() -> Response:
            data = generate_latest(registry_ref)
            return PlainTextResponse(content=data, media_type=CONTENT_TYPE_LATEST)

        app.add_api_route(
            metrics_path,
            _metrics_handler,
            methods=["GET"],
            include_in_schema=False,
        )


class _Dependencies:
    """외부 의존성(예: rabbitmq) 가용성 gauge 업데이트 핸들."""

    def __init__(self, gauge: Gauge) -> None:
        self._gauge = gauge

    def set_ready(self, name: str, ready: bool) -> None:
        self._gauge.labels(dependency=name).set(1 if ready else 0)


def create_metrics(
    *,
    registry: CollectorRegistry | None = None,
    service_name: str = "payment-service",
    metrics_path: str = "/api/payment/metrics",
) -> PaymentMetrics:
    """팩토리: 테스트는 격리 registry 주입, 운영은 기본 registry 사용."""
    return PaymentMetrics(
        registry=registry,
        service_name=service_name,
        metrics_path=metrics_path,
    )
