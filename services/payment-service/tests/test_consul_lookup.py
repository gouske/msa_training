"""
[실전 #6] Consul 조회 모듈 테스트

payment-service 가 Order에 콜백 보내기 직전 Consul에서 인스턴스를 찾는다.
빈 결과는 OrderUnreachableError 예외를 던져 RabbitMQ DLQ 로 흘러가게 한다.
"""
import pytest
from pytest_httpx import HTTPXMock

from infrastructure.consul_lookup import find_instance, OrderUnreachableError


@pytest.mark.asyncio
async def test_find_instance_정상_응답(httpx_mock: HTTPXMock):
    # GIVEN: passing 인스턴스 2개
    httpx_mock.add_response(
        method="GET",
        url="http://consul:8500/v1/health/service/order-service?passing=true",
        json=[
            {"Service": {"ID": "x1", "Address": "order-service-1", "Port": 8081}},
            {"Service": {"ID": "x2", "Address": "order-service-2", "Port": 8081}},
        ],
    )

    # WHEN
    host, port = await find_instance("http://consul:8500", "order-service")

    # THEN: 첫 번째 인스턴스 반환 (라운드로빈 정책 없음 — 단순화)
    assert host == "order-service-1"
    assert port == 8081


@pytest.mark.asyncio
async def test_find_instance_빈_결과는_OrderUnreachableError(httpx_mock: HTTPXMock):
    # GIVEN: 빈 배열
    httpx_mock.add_response(
        method="GET",
        url="http://consul:8500/v1/health/service/order-service?passing=true",
        json=[],
    )

    # WHEN + THEN
    with pytest.raises(OrderUnreachableError) as ei:
        await find_instance("http://consul:8500", "order-service")
    assert "order-service" in str(ei.value)


@pytest.mark.asyncio
async def test_find_instance_Consul_5xx는_OrderUnreachableError(httpx_mock: HTTPXMock):
    # GIVEN: Consul 자체가 다운
    httpx_mock.add_response(
        method="GET",
        url="http://consul:8500/v1/health/service/order-service?passing=true",
        status_code=500,
    )

    # WHEN + THEN
    with pytest.raises(OrderUnreachableError):
        await find_instance("http://consul:8500", "order-service")
