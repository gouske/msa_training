/**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * [제17강 코드 — 제19강에서 사용 중단]
 *
 * 제19강에서 JWT 검증을 Gateway로 중앙화했기 때문에
 * Order Service가 Auth Service를 직접 호출할 필요가 없어졌습니다.
 *
 * index.js에서 이 모듈의 import가 제거되어 실제로 실행되지 않습니다.
 * 이 파일은 제17강 서킷 브레이커 학습 참고용으로 보존합니다.
 * circuitBreaker.test.js도 독립 실행 가능하므로 함께 보존합니다.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

/**
 * [서킷 브레이커 모듈] Auth Service 호출 보호
 *
 * 문제: Auth Service가 다운되면 Order Service도 함께 응답 불가 → 장애 전파
 * 해결: 서킷 브레이커가 실패를 감지하면 호출 자체를 차단하고 즉시 실패 응답 반환
 *
 * 3가지 상태:
 *   CLOSED    (정상)     → Auth Service 정상 호출
 *   OPEN      (차단 중)   → 호출 없이 즉시 fallback 반환 (빠른 실패 / Fail Fast)
 *   HALF-OPEN (회복 시도) → 일부 요청만 통과시켜 복구 여부 확인
 */

const CircuitBreaker = require('opossum');
const axios = require('axios');

// Auth Service 호스트 (Docker: 'auth-service', 로컬: 'localhost')
const authHost = process.env.AUTH_HOST || 'localhost';

/**
 * 보호 대상 함수: Auth Service JWT 검증 HTTP 호출
 * 이 함수가 반복적으로 실패하면 서킷 브레이커가 OPEN 상태로 전환됩니다.
 * @param {string} authHeader - "Bearer {JWT_TOKEN}" 형식의 Authorization 헤더
 */
function validateWithAuthService(authHeader) {
    return axios.get(`http://${authHost}:8080/api/auth/validate`, {
        headers: { Authorization: authHeader },
        timeout: 2000, // axios 자체 타임아웃: 2초
        // validateStatus: 4xx를 에러로 던지지 않고 응답으로 처리합니다.
        // 이유: 401(토큰 무효)은 Auth Service가 정상 동작 중인 것입니다.
        //       CB는 "서비스 다운/타임아웃"만 실패로 봐야 합니다.
        //       5xx(서버 오류)는 서비스 장애이므로 실패로 처리합니다.
        validateStatus: (status) => status < 500,
    });
}

// --- 서킷 브레이커 설정 ---
const options = {
    timeout: 3000,                  // 3초 내 응답 없으면 실패로 처리
    errorThresholdPercentage: 50,   // 요청 중 50% 이상 실패하면 회로 개방(OPEN)
    resetTimeout: 10000,            // OPEN 상태에서 10초 후 HALF-OPEN으로 전환하여 회복 시도
    volumeThreshold: 3,             // 최소 3번 요청 후부터 통계 적용 (소량 테스트 오탐 방지)
};

const authBreaker = new CircuitBreaker(validateWithAuthService, options);

/**
 * Fallback 함수: 회로가 OPEN 상태이거나 모든 재시도가 실패했을 때 실행됩니다.
 * Auth Service를 호출하지 않고 즉시 "인증 거부" 응답을 반환합니다.
 * reason 필드로 index.js에서 서킷 브레이커 차단과 일반 인증 실패를 구분합니다.
 */
authBreaker.fallback(() => {
    return { data: { valid: false, reason: 'circuit_open' } };
});

// --- 상태 변화 이벤트 로깅 ---
// 실무에서는 여기서 Slack 알림, Prometheus 메트릭 전송 등을 추가합니다.
authBreaker.on('open',     () => console.log('🔴 [CB] Auth 서킷 브레이커 OPEN  — Auth Service 호출 차단 중'));
authBreaker.on('halfOpen', () => console.log('🟡 [CB] Auth 서킷 브레이커 HALF-OPEN — 회복 여부 확인 중'));
authBreaker.on('close',    () => console.log('🟢 [CB] Auth 서킷 브레이커 CLOSED — 정상 운영 재개'));
authBreaker.on('fallback', () => console.log('⚡ [CB] Fallback 실행 — Auth Service 응답 없음, 요청 차단'));

/**
 * [테스트용] 커스텀 함수와 옵션으로 새 서킷 브레이커 인스턴스를 생성합니다.
 * 실제 서비스에서는 authBreaker를 사용하고, 테스트에서는 이 팩토리로 격리된 인스턴스를 만듭니다.
 * @param {Function} targetFn - 보호할 함수 (테스트에서는 jest.fn() 전달)
 * @param {Object} customOptions - 옵션 오버라이드 (테스트에서 timeout 등을 짧게 설정)
 */
function createBreaker(targetFn, customOptions = {}) {
    return new CircuitBreaker(targetFn, { ...options, ...customOptions });
}

module.exports = { authBreaker, createBreaker };
