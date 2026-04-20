"""[Issue #8] Correlation ID 검증 헬퍼 단위 테스트.

규칙: ``^[A-Za-z0-9_-]{1,64}$`` 을 만족하는 문자열은 그대로 반환,
     그 외는 새 UUID v4 로 치환.
"""

from __future__ import annotations

import re

import pytest

from infrastructure.correlation_id import (
    CORRELATION_ID_PATTERN,
    normalize_correlation_id,
)

UUID_V4_REGEX = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


class TestAllowedInputs:
    """규칙을 만족하는 입력은 그대로 반환."""

    @pytest.mark.parametrize(
        "value",
        [
            "550e8400-e29b-41d4-a716-446655440000",  # UUID v4
            "trace-12345",
            "my_trace_id",
            "a",  # 최소 길이 1
            "a" * 64,  # 최대 길이 64
        ],
    )
    def test_returns_input_unchanged(self, value: str) -> None:
        assert normalize_correlation_id(value) == value


class TestRejectedInputs:
    """규칙에 맞지 않는 입력은 새 UUID v4 로 치환."""

    @pytest.mark.parametrize(
        "value",
        [
            None,
            "",
            12345,
            {"traceId": "x"},
            ["abc"],
            "a" * 65,  # 한도 초과
            "trace id with space",
            "abc\r\ninjected",  # CRLF 헤더 스머글링
            "trace\x00control",  # NUL 제어문자
            "한글-trace",  # 비ASCII
            "a;b",  # 세미콜론
            "path/like",  # 슬래시
        ],
    )
    def test_replaces_with_new_uuid_v4(self, value: object) -> None:
        result = normalize_correlation_id(value)

        assert UUID_V4_REGEX.match(result), f"UUID v4 아님: {result!r}"
        assert CORRELATION_ID_PATTERN.match(result), (
            f"치환된 값도 허용 규칙을 만족해야 함: {result!r}"
        )

    def test_different_uuids_on_repeated_calls(self) -> None:
        first = normalize_correlation_id(None)
        second = normalize_correlation_id(None)

        assert first != second
        assert UUID_V4_REGEX.match(first)
        assert UUID_V4_REGEX.match(second)
