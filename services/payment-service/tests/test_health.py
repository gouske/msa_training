"""
[실전 #6] /api/payment/health 헬스체크 엔드포인트 단위 테스트
Consul이 10초마다 이 경로를 GET 호출하므로 항상 200을 반환해야 한다.
"""
import pytest
import os
from unittest.mock import patch
from fastapi.testclient import TestClient
from pytest_httpx import HTTPXMock

from main import app

# 테스트에서 사용할 고정 호스트명 — CONSUL_SERVICE_ADDRESS 환경변수로 주입
_TEST_HOST = "payment-service-test"


def test_health_endpoint_200(httpx_mock: HTTPXMock, monkeypatch: pytest.MonkeyPatch):
    """
    lifespan 시작 시 Consul register, 종료 시 deregister HTTP 호출을 모킹하고
    /api/payment/health 가 200 OK를 반환하는지 검증한다.

    CONSUL_SERVICE_ADDRESS 환경변수를 고정값으로 주입하여
    로컬 hostname 차이에 관계없이 일관된 service_id를 사용한다.
    """
    # GIVEN: 환경변수로 호스트명 고정 (Docker 환경 대응 패턴과 동일)
    monkeypatch.setenv("CONSUL_SERVICE_ADDRESS", _TEST_HOST)

    service_id = f"payment-service-{_TEST_HOST}-8082"

    # GIVEN: Consul register 응답 모킹
    httpx_mock.add_response(
        method="PUT",
        url="http://localhost:8500/v1/agent/service/register",
        status_code=200,
    )
    # GIVEN: Consul deregister 응답 모킹
    httpx_mock.add_response(
        method="PUT",
        url=f"http://localhost:8500/v1/agent/service/deregister/{service_id}",
        status_code=200,
    )

    # WHEN: TestClient를 with 블록으로 감싸면 lifespan(startup/shutdown)이 실행됨
    with patch("main.start_consumer"):  # RabbitMQ consumer 스레드 비활성화
        with TestClient(app) as client:
            resp = client.get("/api/payment/health")

    # THEN
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "OK"
