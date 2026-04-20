/**
 * [Issue #8] Correlation ID 검증 헬퍼
 *
 * 외부 클라이언트가 보낸 X-Correlation-ID 값을 그대로 다운스트림(RabbitMQ 메시지,
 * 로그, 콜백 헤더)에 전파하면 악의적 값(과대길이/제어문자/비ASCII)이 들어와
 * Payment Service 의 콜백 헤더 파싱이나 큐 메시지 처리를 망가뜨릴 수 있다
 * (DLQ 오염 가능). Boundary 에서 한 번 검증·정규화한 뒤 사용한다.
 *
 * 규칙:
 *   - 허용 charset: [A-Za-z0-9_-] (URL-safe 문자만)
 *   - 길이: 1 ~ 64 (UUID v4 = 36자 + 여유)
 *   - 그 외(비문자열/형식 불일치)면 서버에서 UUID 를 새로 발급한다.
 *     요청을 거부하지 않는 이유: 추적 가능성을 항상 유지하기 위함.
 */
const { randomUUID } = require('crypto');

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 검증/정규화된 Correlation ID 를 반환한다.
 *
 * 부정 입력(형식 불일치 문자열, 비문자열)이 들어오면 WARN 로그를 남겨
 * 공격 시도/포맷 회귀를 운영에서 관측할 수 있게 한다.
 * 원본 값은 로그에 찍지 않는다 — 로그 인젝션 방지를 위해 길이/타입만 노출.
 * 누락(undefined/null/빈 문자열)은 정상 흐름이라 로그 생략.
 *
 * @param {unknown} value 외부에서 전달된 원시 값 (헤더, 메시지 본문 등)
 * @returns {string}
 */
function normalizeCorrelationId(value) {
    if (typeof value === 'string' && CORRELATION_ID_PATTERN.test(value)) {
        return value;
    }
    const replacement = randomUUID();
    if (value !== undefined && value !== null && value !== '') {
        const descriptor = typeof value === 'string'
            ? `len=${value.length}`
            : `type=${typeof value}`;
        console.warn(
            `[correlation-id] 부정 입력 치환 — ${descriptor} → ${replacement}`
        );
    }
    return replacement;
}

module.exports = { normalizeCorrelationId, CORRELATION_ID_PATTERN };
