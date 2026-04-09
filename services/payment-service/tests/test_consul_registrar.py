"""
[실전 #6] Consul 자기 등록 모듈 테스트

pytest-httpx = httpx 호출을 가로채서 응답을 시뮬레이션하는 라이브러리.
실제 네트워크 호출 없이 register/deregister 동작을 검증한다.
"""
import json
import pytest
from pytest_httpx import HTTPXMock

from infrastructure.consul_registrar import register, deregister


@pytest.mark.asyncio
async def test_register_올바른_페이로드(httpx_mock: HTTPXMock):
    # GIVEN
    httpx_mock.add_response(
        method="PUT",
        url="http://consul:8500/v1/agent/service/register",
        status_code=200,
    )

    # WHEN
    sid = await register(
        consul_url="http://consul:8500",
        name="payment-service",
        host="payment-service",
        port=8082,
        health_path="/api/payment/health",
    )

    # THEN
    assert sid == "payment-service-payment-service-8082"
    req = httpx_mock.get_requests()[0]
    body = json.loads(req.content)
    assert body["Name"] == "payment-service"
    assert body["Port"] == 8082
    assert body["Check"]["HTTP"] == "http://payment-service:8082/api/payment/health"
    assert body["Check"]["Interval"] == "10s"
    assert body["Check"]["DeregisterCriticalServiceAfter"] == "30s"


@pytest.mark.asyncio
async def test_register는_5회_재시도_후_예외_없이_종료(httpx_mock: HTTPXMock):
    # GIVEN: 5회 모두 500
    for _ in range(5):
        httpx_mock.add_response(
            method="PUT",
            url="http://consul:8500/v1/agent/service/register",
            status_code=500,
        )

    # WHEN: 예외 안 던짐
    sid = await register(
        consul_url="http://consul:8500",
        name="payment-service",
        host="h",
        port=8082,
        health_path="/api/payment/health",
    )

    # THEN
    assert sid == "payment-service-h-8082"
    assert len(httpx_mock.get_requests()) == 5


@pytest.mark.asyncio
async def test_deregister는_service_id로_PUT(httpx_mock: HTTPXMock):
    # GIVEN
    httpx_mock.add_response(
        method="PUT",
        url="http://consul:8500/v1/agent/service/deregister/payment-service-h-8082",
        status_code=200,
    )

    # WHEN
    await deregister("http://consul:8500", "payment-service-h-8082")

    # THEN
    assert len(httpx_mock.get_requests()) == 1
