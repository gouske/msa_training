"""[Issue #8] Correlation ID 검증 헬퍼.

Order Service 가 RabbitMQ 메시지 본문에 넣은 ``correlationId`` 를 그대로 콜백 HTTP
헤더(``X-Correlation-ID``)에 재사용하면, 외부 클라이언트가 주입한 부정 값
(과대길이/제어문자/비ASCII)이 콜백 요청을 깨뜨리고 메시지가 DLQ 로 반복 이동할
수 있다. Boundary 에서 한 번 검증·정규화한다.

규칙:
    - 허용 charset: ``[A-Za-z0-9_-]``
    - 길이: 1 ~ 64 (UUID v4 36자 + 여유)
    - 형식 불일치 시 서버에서 UUID v4 신규 발급
      (메시지 처리 자체는 계속 진행 — 추적 가능성 유지)
"""

from __future__ import annotations

import logging
import re
import uuid

CORRELATION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

logger = logging.getLogger(__name__)


def normalize_correlation_id(value: object) -> str:
    """검증된 Correlation ID 를 반환한다.

    부정 입력(형식 불일치 문자열, 비문자열)이 들어오면 WARN 로그를 남겨
    공격 시도/포맷 회귀를 운영에서 관측할 수 있게 한다.
    원본 값은 로그에 기록하지 않고(로그 인젝션 방지) 길이/타입만 노출한다.
    누락(``None``/빈 문자열)은 정상 흐름이라 로그를 남기지 않는다.

    Args:
        value: 외부 입력(문자열일 수도, 다른 타입일 수도 있음).

    Returns:
        검증을 통과한 원본 문자열, 또는 새로 발급된 UUID v4 문자열.
    """
    if isinstance(value, str) and CORRELATION_ID_PATTERN.match(value):
        return value

    replacement = str(uuid.uuid4())
    if value not in (None, ""):
        if isinstance(value, str):
            descriptor = f"len={len(value)}"
        else:
            descriptor = f"type={type(value).__name__}"
        logger.warning(
            "correlation_id 부정 입력 치환 — %s → %s",
            descriptor,
            replacement,
        )
    return replacement
