/**
 * [실전 #6] Consul 자기 등록 모듈
 *
 * Express 부팅 시 register() 호출 → Consul HTTP API에 자기 위치 신고
 * SIGTERM 수신 시 deregister() 호출 → Consul 카탈로그에서 자동 제거
 *
 * 외부 Consul 클라이언트 SDK를 쓰지 않고 axios로 직접 호출 — 4개 언어 비교 학습 목적.
 */
const axios = require('axios');

/**
 * Consul에 자기를 등록한다.
 *
 * @param {Object}   opts
 * @param {string}   opts.consulUrl    - Consul base URL (예: "http://consul-server:8500")
 * @param {string}   opts.name         - 서비스 이름 (예: "order-service")
 * @param {string}   opts.host         - Consul 에 등록할 Address (Pod IP / Docker hostname / 로컬 호스트네임)
 * @param {number}   opts.port         - 자기 포트
 * @param {string}   opts.healthPath   - 헬스체크 경로 (예: "/api/order/health")
 * @param {string}  [opts.instanceKey] - [K8s + Consul 회고] serviceId 의 인스턴스 식별자.
 *                                       K8s 환경에서는 POD_NAME 을 넘겨 replica 간 ID 충돌을 차단한다.
 *                                       생략하면 host 가 그대로 사용된다 (Docker Compose 기존 동작 호환).
 * @returns {Promise<string>} service-id
 */
async function register({ consulUrl, name, host, port, healthPath, instanceKey }) {
    // serviceId 인스턴스 키: instanceKey > host. K8s 환경에서는 instanceKey = POD_NAME.
    // 이전: 모든 replica 가 같은 host(K8s Service DNS) 로 등록되어 serviceId 가 충돌했음.
    const id = `${name}-${instanceKey || host}-${port}`;
    const payload = {
        ID: id,
        Name: name,
        Address: host,
        Port: port,
        Check: {
            HTTP: `http://${host}:${port}${healthPath}`,
            Interval: '10s',
            Timeout: '2s',
            DeregisterCriticalServiceAfter: '30s',
        },
    };

    // 5회 재시도 (exponential backoff)
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            await axios.put(`${consulUrl}/v1/agent/service/register`, payload);
            console.log(`Consul 등록 성공: id=${id}`);
            return id;
        } catch (err) {
            console.warn(`Consul 등록 실패 (${attempt}/5): ${err.message}`);
            if (attempt < 5) {
                await new Promise((r) => setTimeout(r, Math.min(100 * 2 ** (attempt - 1), 2000)));
            }
        }
    }
    console.error(`Consul 등록 5회 모두 실패. id=${id} 격리된 상태로 계속 동작합니다.`);
    return id;
}

/**
 * Consul에서 자기를 해제한다. 실패해도 예외 던지지 않음.
 */
async function deregister(consulUrl, serviceId) {
    try {
        await axios.put(`${consulUrl}/v1/agent/service/deregister/${serviceId}`);
        console.log(`Consul 해제 성공: id=${serviceId}`);
    } catch (err) {
        console.warn(`Consul 해제 실패 (무시): ${err.message}`);
    }
}

/**
 * SIGTERM 핸들러를 등록한다. Docker가 컨테이너 종료 시 SIGTERM을 보내면
 * 워커 정리 → Consul 해제 → 종료.
 *
 * @param {string} consulUrl - Consul URL
 * @param {string} serviceId - Service ID
 * @param {() => void} [onShutdown] - [Phase 4b] SIGTERM 수신 시 먼저 호출할 정리 콜백(타이머/구독 취소)
 */
function setupGracefulShutdown(consulUrl, serviceId, onShutdown) {
    process.on('SIGTERM', async () => {
        console.log('SIGTERM 수신 — graceful shutdown 시작');
        // [Phase 4b] 워커(릴레이/스윕/리플라이) 타이머·구독을 먼저 정리한다.
        try { if (typeof onShutdown === 'function') onShutdown(); }
        catch (e) { console.warn('shutdown 정리 중 오류(무시):', e.message); }
        await deregister(consulUrl, serviceId);
        process.exit(0);
    });
}

module.exports = { register, deregister, setupGracefulShutdown };
