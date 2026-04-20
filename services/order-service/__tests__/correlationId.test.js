/**
 * [Issue #8] Correlation ID 검증 헬퍼 단위 테스트
 *
 * 목적:
 *   - 허용 규칙(`^[A-Za-z0-9_-]{1,64}$`) 을 만족하는 문자열은 그대로 반환
 *   - 그 외 모든 경우(형식 불일치/비문자열/공백 포함)는 새 UUID v4 로 치환
 */

const { normalizeCorrelationId, CORRELATION_ID_PATTERN } = require('../src/utils/correlationId');

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('normalizeCorrelationId', () => {
    describe('허용되는 입력은 그대로 반환', () => {
        test.each([
            ['UUID v4', '550e8400-e29b-41d4-a716-446655440000'],
            ['영문/숫자 조합', 'trace-12345'],
            ['밑줄 포함', 'my_trace_id'],
            ['단일 문자 (최소 길이 1)', 'a'],
            ['최대 길이 64자', 'a'.repeat(64)],
        ])('%s', (_, input) => {
            expect(normalizeCorrelationId(input)).toBe(input);
        });
    });

    describe('허용되지 않는 입력은 새 UUID v4 로 치환', () => {
        test.each([
            ['null', null],
            ['undefined', undefined],
            ['빈 문자열', ''],
            ['숫자 타입', 12345],
            ['객체 타입', { traceId: 'x' }],
            ['배열 타입', ['abc']],
            ['65자 (한도 초과)', 'a'.repeat(65)],
            ['공백 포함', 'trace id with space'],
            ['CRLF (헤더 스머글링)', 'abc\r\ninjected'],
            ['NUL 제어문자', 'trace\u0000control'],
            ['비ASCII', '한글-trace'],
            ['세미콜론', 'a;b'],
            ['슬래시', 'path/like'],
        ])('%s', (_, input) => {
            const result = normalizeCorrelationId(input);
            expect(result).toMatch(UUID_V4_REGEX);
            expect(CORRELATION_ID_PATTERN.test(result)).toBe(true); // 치환값도 규칙 만족
        });
    });

    test('연속 호출 시 매번 서로 다른 UUID 를 생성한다', () => {
        const a = normalizeCorrelationId(null);
        const b = normalizeCorrelationId(null);
        expect(a).not.toBe(b);
        expect(a).toMatch(UUID_V4_REGEX);
        expect(b).toMatch(UUID_V4_REGEX);
    });
});
