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

import re
import uuid

CORRELATION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def normalize_correlation_id(value: object) -> str:
    """검증된 Correlation ID 를 반환한다.

    Args:
        value: 외부 입력(문자열일 수도, 다른 타입일 수도 있음).

    Returns:
        검증을 통과한 원본 문자열, 또는 새로 발급된 UUID v4 문자열.
    """
    if isinstance(value, str) and CORRELATION_ID_PATTERN.match(value):
        return value
    return str(uuid.uuid4())
