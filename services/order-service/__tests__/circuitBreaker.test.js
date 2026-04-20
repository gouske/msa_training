/**
 * [테스트] 서킷 브레이커 동작 검증
 *
 * 학습 포인트:
 *   1. jest.fn()으로 외부 HTTP 호출을 대체하는 방법
 *   2. 서킷 브레이커 3가지 상태(CLOSED/OPEN/HALF-OPEN)의 실제 동작
 *   3. 테스트에서 팩토리 함수(createBreaker)를 쓰는 이유
 *
 * 실행: npm test
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * [flakiness 수정 — Issue #9]
 * 기존 테스트는 `setTimeout` 으로 resetTimeout 을 기다리고 `breaker.opened`
 * 를 바로 체크했는데, opossum 9 의 실제 semantics 때문에 flaky 했다:
 *   1) `errorThresholdPercentage: 100` 은 "100% 초과" 라 실패해도 OPEN 안 됨
 *   2) `volumeThreshold: 3` 은 opossum 9 에서 3 번 실패해도 OPEN 전환 안 됨
 *   3) `setTimeout` 대기는 이벤트 루프 타이밍에 민감
 * 해결: 임계값을 opossum 9 semantics 에 맞게 재조정하고,
 *       상태 전환은 opossum 의 'open' / 'halfOpen' / 'close' 이벤트로 동기화.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

const { createBreaker } = require('../circuitBreaker');

// ----------------------------------------------------------
// 테스트 공통 옵션
// 실제 환경보다 빠르게 상태 전환되도록 값을 줄였습니다.
//
// [opossum 9 호환 주의]
//   1) `errorThresholdPercentage: 50` — "50% 를 초과해야" OPEN 전환.
//      기존 100% 는 100% 실패해도 절대 열리지 않아 flaky 원인이 되었다.
//   2) `volumeThreshold: 0` — 0 이어야 첫 실패부터 통계 반영된다.
//      production 의 `volumeThreshold: 3` 은 소량 오탐 방지용이지만 테스트에서는
//      결정론적 검증을 위해 0 을 사용 (production 모듈은 그대로 유지).
//   3) 위 두 설정 조합 → 첫 실패 시점에 바로 OPEN 으로 전환된다.
//      따라서 "n 번 실패 후 OPEN" 형식 대신 "OPEN 에 도달했다" 사실만 검증한다.
// ----------------------------------------------------------
const TEST_OPTIONS = {
    timeout: 500,                   // 실제 3000ms → 500ms (빠른 테스트)
    errorThresholdPercentage: 50,   // 50% 초과 실패 시 OPEN — opossum 9 호환
    resetTimeout: 300,              // 실제 10000ms → 300ms (빠른 HALF-OPEN 전환)
    volumeThreshold: 0,             // 0 이어야 첫 실패부터 통계 반영 (opossum 9 호환)
};

// 테스트 전체에 적용할 이벤트 대기 타임아웃 (CI 환경 여유 고려해 2초)
const EVENT_TIMEOUT_MS = 2000;

/**
 * opossum 의 상태 전환 이벤트를 Promise 로 감싸 결정론적으로 대기한다.
 *
 * wall-clock 기반 `setTimeout` 보다 안전한 이유:
 *   - opossum 이 상태를 emit 한 시점에 resolve 되므로 microtask 순서 이슈가 없다
 *   - CI(Linux) vs 로컬(macOS) 의 타이머 해상도 차이에 영향받지 않는다
 *
 * @param {*}      breaker   CircuitBreaker 인스턴스
 * @param {string} event     'open' | 'halfOpen' | 'close' 중 하나
 * @param {number} timeoutMs 이 시간 내 이벤트가 오지 않으면 테스트 실패
 */
function waitForEvent(breaker, event, timeoutMs = EVENT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`서킷 브레이커 '${event}' 이벤트 대기 타임아웃 (${timeoutMs}ms)`));
        }, timeoutMs);
        breaker.once(event, () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

/**
 * 헬퍼 함수: 브레이커를 강제로 OPEN 상태로 만든다.
 * 'open' 이벤트를 먼저 구독한 뒤 실패 요청을 보내고 이벤트 도달까지 await 한다.
 *
 * opossum 9 + TEST_OPTIONS(50%, volumeThreshold 0) 조합에서는
 * 첫 실패로 이미 OPEN 이 되므로 루프 2~3 회차 fire 는 fallback 경로를 탄다.
 * 그래도 'open' 이벤트는 한 번만 emit 되어 문제 없다.
 */
async function forceOpen(breaker) {
    const opened = waitForEvent(breaker, 'open');
    for (let i = 0; i < 3; i++) {
        try {
            await breaker.fire('Bearer test-token');
        } catch (_) {
            // 실패 예외는 무시 (CB 가 상태를 기록하는 것이 목적)
        }
    }
    await opened;
}

// ==========================================================
// 1. CLOSED 상태: 정상 운영
// ==========================================================
describe('CLOSED 상태 (정상 운영)', () => {

    test('Auth Service 성공 시 응답을 그대로 반환한다', async () => {
        const mockAuthCall = jest.fn().mockResolvedValue({
            data: { valid: true, email: 'test@test.com' }
        });
        const breaker = createBreaker(mockAuthCall, TEST_OPTIONS);

        const result = await breaker.fire('Bearer valid-token');

        expect(result.data.valid).toBe(true);
        expect(result.data.email).toBe('test@test.com');
        expect(breaker.opened).toBe(false);
    });

    test('인증 실패(401) 응답도 CB 장애로 처리하지 않는다', async () => {
        // validateStatus 덕분에 401 도 throw 없이 응답 객체로 반환됨.
        // 401 은 "토큰이 잘못됐다"는 정상 응답이므로 CB 는 CLOSED 유지.
        const mockAuthCall = jest.fn().mockResolvedValue({
            data: { valid: false }
        });
        const breaker = createBreaker(mockAuthCall, TEST_OPTIONS);

        const result = await breaker.fire('Bearer invalid-token');

        expect(result.data.valid).toBe(false);
        expect(breaker.opened).toBe(false);
    });

    test('Auth Service 를 실제로 호출한다 (mock 호출 횟수 확인)', async () => {
        const mockAuthCall = jest.fn().mockResolvedValue({
            data: { valid: true, email: 'user@test.com' }
        });
        const breaker = createBreaker(mockAuthCall, TEST_OPTIONS);

        await breaker.fire('Bearer token-1');
        await breaker.fire('Bearer token-2');

        expect(mockAuthCall).toHaveBeenCalledTimes(2);
    });
});

// ==========================================================
// 2. CLOSED → OPEN 상태 전환: 장애 감지
// ==========================================================
describe('OPEN 상태 전환 (장애 감지)', () => {

    test('연속 실패 시 CB 가 OPEN 으로 전환된다', async () => {
        const mockAuthCall = jest.fn().mockRejectedValue(
            new Error('connect ECONNREFUSED 127.0.0.1:8080')
        );
        const breaker = createBreaker(mockAuthCall, TEST_OPTIONS);

        await forceOpen(breaker);

        expect(breaker.opened).toBe(true);
    });

    test('OPEN 상태에서 fallback 응답을 반환한다', async () => {
        const mockAuthCall = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        const breaker = createBreaker(mockAuthCall, TEST_OPTIONS);
        breaker.fallback(() => ({ data: { valid: false, reason: 'circuit_open' } }));

        await forceOpen(breaker);

        const result = await breaker.fire('Bearer any-token');

        expect(result.data.valid).toBe(false);
        expect(result.data.reason).toBe('circuit_open');
    });

    test('[Fail Fast] OPEN 이후 추가 요청은 Auth Service 를 호출하지 않는다', async () => {
        // 서킷 브레이커의 핵심 가치: 장애 중인 Auth Service 로 재시도가 쏠리지 않도록
        // OPEN 상태에서는 실제 호출 없이 fallback 경로만 실행되어야 한다.
        const mockAuthCall = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        const breaker = createBreaker(mockAuthCall, TEST_OPTIONS);
        breaker.fallback(() => ({ data: { valid: false, reason: 'circuit_open' } }));

        await forceOpen(breaker);
        const callsUntilOpen = mockAuthCall.mock.calls.length;

        // WHEN: OPEN 상태에서 5번 추가 호출
        for (let i = 0; i < 5; i++) {
            await breaker.fire('Bearer token');
        }

        // THEN: 호출 횟수가 증가하지 않아야 한다 (모두 fallback 경로)
        expect(mockAuthCall).toHaveBeenCalledTimes(callsUntilOpen);
    });
});

// ==========================================================
// 3. HALF-OPEN → CLOSED: 자동 복구
// ==========================================================
describe('HALF-OPEN 상태 (자동 복구)', () => {

    test('resetTimeout 후 HALF-OPEN 으로 전환되어 서비스 복구 시 CLOSED 로 돌아온다', async () => {
        // GIVEN: 1번 실패 후 복구 (opossum 9 + TEST_OPTIONS 에서 첫 실패로 OPEN)
        const mockAuthCall = jest.fn()
            .mockRejectedValueOnce(new Error('ECONNREFUSED'))
            .mockResolvedValue({ data: { valid: true, email: 'recovered@test.com' } });

        const breaker = createBreaker(mockAuthCall, TEST_OPTIONS);
        breaker.fallback(() => ({ data: { valid: false, reason: 'circuit_open' } }));

        // STEP 1: OPEN 전환 + 이벤트 동기화
        await forceOpen(breaker);
        expect(breaker.opened).toBe(true);

        // STEP 2: resetTimeout(300ms) 경과 후 HALF-OPEN 이벤트 대기
        //         'close' 구독은 fire 전에 걸어두어야 놓치지 않음
        const closed = waitForEvent(breaker, 'close');
        await waitForEvent(breaker, 'halfOpen');

        // STEP 3: HALF-OPEN 에서 성공 fire → CLOSED 전환
        const result = await breaker.fire('Bearer token');
        await closed;

        expect(result.data.valid).toBe(true);
        expect(breaker.opened).toBe(false);
    }, 5000);

    test('HALF-OPEN 에서 재실패하면 다시 OPEN 으로 전환된다', async () => {
        const mockAuthCall = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        const breaker = createBreaker(mockAuthCall, TEST_OPTIONS);
        breaker.fallback(() => ({ data: { valid: false, reason: 'circuit_open' } }));

        // STEP 1: OPEN 전환
        await forceOpen(breaker);

        // STEP 2: HALF-OPEN 진입까지 대기
        await waitForEvent(breaker, 'halfOpen');

        // STEP 3: HALF-OPEN 에서 재실패 시 'open' 이벤트 재발행을 대기
        const reopened = waitForEvent(breaker, 'open');
        await breaker.fire('Bearer token').catch(() => { /* fire reject 는 무시 */ });
        await reopened;

        expect(breaker.opened).toBe(true);
    }, 5000);
});
