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
) -> str:
    """
    Consul에 자기를 등록한다. 5회 재시도 후 실패해도 예외 던지지 않음
    (서비스 부팅 자체는 성공해야 한다는 원칙 — Consul이 SPOF가 되면 안 됨).

    Returns:
        service_id (예: "payment-service-payment-service-8082")
    """
    service_id = f"{name}-{host}-{port}"
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
