"""
[실전 #6] Consul 자기 등록 모듈

FastAPI lifespan startup 단계에서 register() 호출,
shutdown 단계에서 deregister() 호출.

외부 Consul SDK 없이 httpx로 직접 HTTP 호출 — 4개 언어 비교 학습 목적.
"""
import asyncio
import logging
import httpx

logger = logging.getLogger(__name__)


async def register(
    consul_url: str,
    name: str,
    host: str,
    port: int,
    health_path: str,
    instance_key: str | None = None,
) -> str:
    """
    Consul에 자기를 등록한다. 5회 재시도 후 실패해도 예외 던지지 않음
    (서비스 부팅 자체는 성공해야 한다는 원칙 — Consul이 SPOF가 되면 안 됨).

    Args:
        instance_key: [K8s + Consul 회고] serviceId 의 인스턴스 식별자.
            K8s 환경에서는 POD_NAME 을 넘겨 replica 간 ID 충돌을 차단한다.
            생략하면 host 가 그대로 사용된다 (Docker Compose 기존 동작 호환).

    Returns:
        service_id (예: "payment-service-payment-service-8082")
    """
    # serviceId 인스턴스 키: instance_key > host. K8s 환경에서는 instance_key = POD_NAME.
    # 이전: 모든 replica 가 같은 host(K8s Service DNS) 로 등록되어 serviceId 가 충돌했음.
    service_id = f"{name}-{instance_key or host}-{port}"
    payload = {
        "ID": service_id,
        "Name": name,
        "Address": host,
        "Port": port,
        "Check": {
            "HTTP": f"http://{host}:{port}{health_path}",
            "Interval": "10s",
            "Timeout": "2s",
            "DeregisterCriticalServiceAfter": "30s",
        },
    }

    for attempt in range(1, 6):
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.put(
                    f"{consul_url}/v1/agent/service/register",
                    json=payload,
                )
            if resp.status_code == 200:
                logger.info("Consul 등록 성공: id=%s", service_id)
                return service_id
            logger.warning("Consul 등록 실패 (%d/5): HTTP %d", attempt, resp.status_code)
        except Exception as e:
            logger.warning("Consul 등록 실패 (%d/5): %s", attempt, e)
        if attempt < 5:
            await asyncio.sleep(min(0.1 * (2 ** (attempt - 1)), 2.0))

    logger.error("Consul 등록 5회 모두 실패. id=%s 격리된 상태로 계속 동작.", service_id)
    return service_id


async def deregister(consul_url: str, service_id: str) -> None:
    """Consul에서 자기를 해제한다. 실패해도 예외 던지지 않음."""
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            await client.put(
                f"{consul_url}/v1/agent/service/deregister/{service_id}",
            )
        logger.info("Consul 해제 성공: id=%s", service_id)
    except Exception as e:
        logger.warning("Consul 해제 실패 (무시): %s", e)
