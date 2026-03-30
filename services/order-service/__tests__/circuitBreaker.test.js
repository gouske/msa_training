/**
 * [테스트] 서킷 브레이커 동작 검증
 *
 * 학습 포인트:
 *   1. jest.fn()으로 외부 HTTP 호출을 대체하는 방법
 *   2. 서킷 브레이커 3가지 상태(CLOSED/OPEN/HALF-OPEN)의 실제 동작
 *   3. 테스트에서 팩토리 함수(createBreaker)를 쓰는 이유
 *
 * 실행: npm test
 */

const { createBreaker } = require('../circuitBreaker');

// ----------------------------------------------------------
// 테스트 공통 옵션
// 실제 환경보다 빠르게 상태 전환되도록 값을 줄였습니다.
// ----------------------------------------------------------
const TEST_OPTIONS = {
    timeout: 500,                   // 실제 3000ms → 500ms (빠른 테스트)
    errorThresholdPercentage: 100,  // 실제 50%  → 100% (명확한 상태 전환)
    resetTimeout: 300,              // 실제 10000ms → 300ms (빠른 HALF-OPEN 전환)
    volumeThreshold: 3,             // 최소 3번 요청 후 통계 적용 (그대로 유지)
};

/**
 * 헬퍼 함수: 브레이커를 강제로 OPEN 상태로 만듭니다.
 * volumeThreshold(3)번 요청이 모두 실패해야 OPEN으로 전환됩니다.
 */
async function forceOpen(breaker) {
    for (let i = 0; i < 3; i++) {
        try {
            await breaker.fire('Bearer test-token');
        } catch (_) {
            // 실패 예외는 무시 (CB가 상태를 기록하는 것이 목적)
        }
    }
}

// ==========================================================
// 1. CLOSED 상태: 정상 운영
// ==========================================================
describe('CLOSED 상태 (정상 운영)', () => {

    test('Auth Service 성공 시 응답을 그대로 반환한다', async () => {
        // GIVEN: Auth Service가 정상 응답하는 가짜(mock) 함수
        const mockAuthCall = jest.fn().mockResolvedValue({
            data: { valid: true, email: 'test@test.com' }
        });
        const breaker = createBreaker(mockAuthCall, TEST_OPTIONS);

        // WHEN: 서킷 브레이커를 통해 호출
        const result = await breaker.fire('Bearer valid-token');

        // THEN
        expect(result.data.valid).toBe(true);
        expect(result.data.email).toBe('test@test.com');
        expect(breaker.opened).toBe(false); // CB는 여전히 CLOSED
    });

    test('인증 실패(401) 응답도 CB 장애로 처리하지 않는다', async () => {
        // GIVEN: validateStatus 덕분에 401도 throw 없이 응답 객체로 반환됨
        // 401은 "토큰이 잘못됐다"는 정상적인 Auth Service의 응답이므로
        // 서비스 장애가 아닙니다 → CB는 CLOSED 유지
        const mockAuthCall = jest.fn().mockResolvedValue({
            data: { valid: false }
        });
        const breaker = createBreaker(mockAuthCall, TEST_OPTIONS);

        const result = await breaker.fire('Bearer invalid-token');

        expect(result.data.valid).toBe(false);
        expect(breaker.opened).toBe(false); // 인증 실패 ≠ 서비스 장애
    });

    test('Auth Service를 실제로 호출한다 (mock 호출 횟수 확인)', async () => {
        const mockAuthCall = jest.fn().mockResolvedValue({
            data: { valid: true, email: 'user@test.com' }
        });
        const breaker = createBreaker(mockAuthCall, TEST_OPTIONS);

        await breaker.fire('Bearer token-1');
        await breaker.fire('Bearer token-2');

        // 2번 호출했으면 mock도 2번 실행되어야 함
        expect(mockAuthCall).toHaveBeenCalledTimes(2);
    });
});

// ==========================================================
// 2. CLOSED → OPEN 상태 전환: 장애 감지
// ==========================================================
describe('OPEN 상태 전환 (장애 감지)', () => {

    test('3번 연속 실패 후 CB가 OPEN으로 전환된다', async () => {
        // GIVEN: Auth Service 연결 불가 시뮬레이션
        const mockAuthCall = jest.fn().mockRejectedValue(
            new Error('connect ECONNREFUSED 127.0.0.1:8080')
        );
        const breaker = createBreaker(mockAuthCall, TEST_OPTIONS);

        // WHEN: volumeThreshold(3)번 실패
        await forceOpen(breaker);

        // THEN: 회로 개방
        expect(breaker.opened).toBe(true);
    });

    test('OPEN 상태에서 fallback 응답을 반환한다', async () => {
        // GIVEN
        const mockAuthCall = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        const breaker = createBreaker(mockAuthCall, TEST_OPTIONS);
        // 실제 circuitBreaker.js의 fallback과 동일한 형식으로 등록
        breaker.fallback(() => ({ data: { valid: false, reason: 'circuit_open' } }));

        await forceOpen(breaker);

        // WHEN: OPEN 상태에서 fire() 호출
        const result = await breaker.fire('Bearer any-token');

        // THEN: fallback 응답 반환
        expect(result.data.valid).toBe(false);
        expect(result.data.reason).toBe('circuit_open');
    });

    test('[Fail Fast] OPEN 상태에서 Auth Service는 호출되지 않는다', async () => {
        // 서킷 브레이커의 핵심 가치: Auth Service가 다운됐을 때
        // 계속 연결 시도를 하지 않아 Auth Service에 불필요한 부하를 주지 않습니다.
        const mockAuthCall = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        const breaker = createBreaker(mockAuthCall, TEST_OPTIONS);
        breaker.fallback(() => ({ data: { valid: false, reason: 'circuit_open' } }));

        // OPEN 전환 (3번 호출)
        await forceOpen(breaker);
        expect(mockAuthCall).toHaveBeenCalledTimes(3);

        // WHEN: OPEN 상태에서 5번 추가 호출
        for (let i = 0; i < 5; i++) {
            await breaker.fire('Bearer token');
        }

        // THEN: Auth Service 호출 횟수는 여전히 3번 (5번 추가됐지만 호출 없음)
        expect(mockAuthCall).toHaveBeenCalledTimes(3);
    });
});

// ==========================================================
// 3. HALF-OPEN → CLOSED: 자동 복구
// ==========================================================
describe('HALF-OPEN 상태 (자동 복구)', () => {

    test('resetTimeout 후 HALF-OPEN으로 전환되어 서비스 복구 시 CLOSED로 돌아온다', async () => {
        // GIVEN: 처음 3번은 실패, 이후엔 성공 (복구됐다고 가정)
        const mockAuthCall = jest.fn()
            .mockRejectedValueOnce(new Error('ECONNREFUSED'))
            .mockRejectedValueOnce(new Error('ECONNREFUSED'))
            .mockRejectedValueOnce(new Error('ECONNREFUSED'))
            .mockResolvedValue({ data: { valid: true, email: 'recovered@test.com' } }); // 복구!

        const breaker = createBreaker(mockAuthCall, TEST_OPTIONS);
        breaker.fallback(() => ({ data: { valid: false, reason: 'circuit_open' } }));

        // STEP 1: OPEN 전환
        await forceOpen(breaker);
        expect(breaker.opened).toBe(true);

        // STEP 2: resetTimeout(300ms) 대기 → 자동으로 HALF-OPEN 전환
        await new Promise(resolve => setTimeout(resolve, 400));

        // STEP 3: HALF-OPEN 상태에서 호출 → Auth Service 복구 확인
        const result = await breaker.fire('Bearer token');

        // THEN: 성공 응답 반환 + CB가 CLOSED로 복구
        expect(result.data.valid).toBe(true);
        expect(breaker.opened).toBe(false); // CLOSED 상태로 복구됨!
    }, 3000); // 이 테스트는 타이머를 사용하므로 타임아웃을 3초로 설정

    test('HALF-OPEN에서 재실패하면 다시 OPEN으로 전환된다', async () => {
        // GIVEN: 계속 실패 (복구 안 됨)
        const mockAuthCall = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        const breaker = createBreaker(mockAuthCall, TEST_OPTIONS);
        breaker.fallback(() => ({ data: { valid: false, reason: 'circuit_open' } }));

        // STEP 1: OPEN 전환
        await forceOpen(breaker);

        // STEP 2: resetTimeout 대기
        await new Promise(resolve => setTimeout(resolve, 400));

        // STEP 3: HALF-OPEN에서 실패 → 다시 OPEN
        try {
            await breaker.fire('Bearer token');
        } catch (_) {}

        // THEN: 다시 OPEN 상태
        expect(breaker.opened).toBe(true);
    }, 3000);
});
