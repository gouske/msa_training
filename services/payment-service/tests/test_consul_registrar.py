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


# ──────────────────────────────────────────────────────────────────────
# [K8s + Consul 회고] instance_key 옵션 (POD_NAME 주입 시나리오).
#
# 기존 결함: K8s replicas=2 환경에서 두 Pod 모두 host="payment-service" 로
#          serviceId="payment-service-payment-service-8082" 가 동일 → ID 충돌.
# 해결: instance_key = POD_NAME 을 넘기면 serviceId 가 replica 마다 유니크.
# ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_instance_key가_주어지면_serviceId의_인스턴스_키로_사용된다(httpx_mock: HTTPXMock):
    # GIVEN: K8s 처럼 host=POD_IP, instance_key=POD_NAME
    httpx_mock.add_response(
        method="PUT",
        url="http://consul:8500/v1/agent/service/register",
        status_code=200,
    )

    # WHEN
    sid = await register(
        consul_url="http://consul:8500",
        name="payment-service",
        host="10.244.0.42",
        port=8082,
        health_path="/api/payment/health",
        instance_key="payment-service-deadbeef-x12k9",
    )

    # THEN: Address 는 host(POD_IP), serviceId 의 인스턴스 키는 POD_NAME
    assert sid == "payment-service-payment-service-deadbeef-x12k9-8082"
    req = httpx_mock.get_requests()[0]
    body = json.loads(req.content)
    assert body["Address"] == "10.244.0.42"
    assert body["Check"]["HTTP"] == "http://10.244.0.42:8082/api/payment/health"


@pytest.mark.asyncio
async def test_두_Pod의_instance_key가_다르면_serviceId가_달라진다(httpx_mock: HTTPXMock):
    # GIVEN: 같은 K8s Service 의 replica 2개 (POD_NAME 만 다름)
    for _ in range(2):
        httpx_mock.add_response(
            method="PUT",
            url="http://consul:8500/v1/agent/service/register",
            status_code=200,
        )

    # WHEN
    id1 = await register(
        consul_url="http://consul:8500",
        name="payment-service",
        host="10.244.0.42",
        port=8082,
        health_path="/api/payment/health",
        instance_key="payment-service-deadbeef-x12k9",
    )
    id2 = await register(
        consul_url="http://consul:8500",
        name="payment-service",
        host="10.244.0.43",
        port=8082,
        health_path="/api/payment/health",
        instance_key="payment-service-deadbeef-y77m2",
    )

    # THEN: 두 ID 가 다르다 (한 Pod 의 deregister 가 다른 Pod 를 건드리지 않게 됨)
    assert id1 != id2
    assert id1 == "payment-service-payment-service-deadbeef-x12k9-8082"
    assert id2 == "payment-service-payment-service-deadbeef-y77m2-8082"


@pytest.mark.asyncio
async def test_instance_key_미지정이면_host가_그대로_사용된다(httpx_mock: HTTPXMock):
    # GIVEN: Docker Compose 처럼 instance_key 없이 hostname 만 전달
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

    # THEN: 기존 동작 그대로 — serviceId = name-host-port
    assert sid == "payment-service-payment-service-8082"
