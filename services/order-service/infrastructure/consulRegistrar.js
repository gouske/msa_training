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
 * @param {string}   opts.consulUrl   - Consul base URL (예: "http://consul-server:8500")
 * @param {string}   opts.name        - 서비스 이름 (예: "order-service")
 * @param {string}   opts.host        - 자기 호스트명 (Docker에서는 컨테이너 이름)
 * @param {number}   opts.port        - 자기 포트
 * @param {string}   opts.healthPath  - 헬스체크 경로 (예: "/api/order/health")
 * @returns {Promise<string>} service-id
 */
async function register({ consulUrl, name, host, port, healthPath }) {
    const id = `${name}-${host}-${port}`;
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
 * Consul에서 먼저 자기를 빼고 → process.exit(0).
 */
function setupGracefulShutdown(consulUrl, serviceId) {
    process.on('SIGTERM', async () => {
        console.log('SIGTERM 수신 — Consul 해제 시작');
        await deregister(consulUrl, serviceId);
        process.exit(0);
    });
}

module.exports = { register, deregister, setupGracefulShutdown };
