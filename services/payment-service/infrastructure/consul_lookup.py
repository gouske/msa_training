"""
[실전 #6] Consul 서비스 조회 모듈

payment-service Consumer 가 Order 콜백을 보내기 직전 호출.
빈 결과/네트워크 실패는 OrderUnreachableError 예외 → 메시지 DLQ로 흘러감 (실전 #4).
"""
import logging
import httpx

logger = logging.getLogger(__name__)


class OrderUnreachableError(Exception):
    """Consul에서 order-service의 passing 인스턴스를 찾을 수 없음."""
    pass


async def find_instance(consul_url: str, service_name: str) -> tuple[str, int]:
    """
    passing 인스턴스 중 첫 번째를 반환한다.
    라운드로빈 정책은 본 강의 범위 밖 (Gateway 쪽이 진짜 LB 데모).

    Returns:
        (address, port)

    Raises:
        OrderUnreachableError: 빈 결과 또는 Consul 자체 실패
    """
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(
                f"{consul_url}/v1/health/service/{service_name}",
                params={"passing": "true"},
            )
        if resp.status_code != 200:
            raise OrderUnreachableError(
                f"Consul returned {resp.status_code} for {service_name}"
            )
        instances = resp.json()
    except httpx.HTTPError as e:
        raise OrderUnreachableError(f"Consul lookup failed for {service_name}: {e}")

    if not instances:
        raise OrderUnreachableError(
            f"No passing instances for {service_name}"
        )

    svc = instances[0]["Service"]
    return svc["Address"], svc["Port"]
