/**
 * [실전 #6] Consul 자기 등록 모듈 테스트
 *
 * nock = Node.js 표준 HTTP mocking 라이브러리.
 * 실제 네트워크 호출 없이 axios.put() 을 가로채서 응답을 시뮬레이션한다.
 */
const nock = require('nock');
const { register, deregister, setupGracefulShutdown } = require('../infrastructure/consulRegistrar');

const CONSUL_BASE = 'http://consul-test:8500';

afterEach(() => {
    nock.cleanAll();
});

describe('consulRegistrar', () => {
    test('register는 올바른 페이로드로 PUT 호출 후 service-id 반환', async () => {
        // GIVEN
        let receivedBody;
        nock(CONSUL_BASE)
            .put('/v1/agent/service/register', (body) => {
                receivedBody = body;
                return true;
            })
            .reply(200);

        // WHEN
        const id = await register({
            consulUrl: CONSUL_BASE,
            name: 'order-service',
            host: 'order-service-1',
            port: 8081,
            healthPath: '/api/order/health',
        });

        // THEN
        expect(id).toBe('order-service-order-service-1-8081');
        expect(receivedBody.ID).toBe(id);
        expect(receivedBody.Name).toBe('order-service');
        expect(receivedBody.Address).toBe('order-service-1');
        expect(receivedBody.Port).toBe(8081);
        expect(receivedBody.Check.HTTP).toBe('http://order-service-1:8081/api/order/health');
        expect(receivedBody.Check.Interval).toBe('10s');
        expect(receivedBody.Check.DeregisterCriticalServiceAfter).toBe('30s');
    });

    test('register는 실패 시 3회 재시도 후 성공', async () => {
        // GIVEN: 첫 2회 500, 3회 200
        nock(CONSUL_BASE).put('/v1/agent/service/register').reply(500);
        nock(CONSUL_BASE).put('/v1/agent/service/register').reply(500);
        nock(CONSUL_BASE).put('/v1/agent/service/register').reply(200);

        // WHEN
        const id = await register({
            consulUrl: CONSUL_BASE,
            name: 'order-service',
            host: 'h',
            port: 8081,
            healthPath: '/api/order/health',
        });

        // THEN
        expect(id).toBe('order-service-h-8081');
    });

    test('register는 5회 모두 실패해도 예외 안 던지고 ID 반환', async () => {
        // GIVEN: 5회 모두 500
        for (let i = 0; i < 5; i++) {
            nock(CONSUL_BASE).put('/v1/agent/service/register').reply(500);
        }

        // WHEN + THEN: 예외 안 던지고 ID는 반환
        const id = await register({
            consulUrl: CONSUL_BASE,
            name: 'order-service',
            host: 'h',
            port: 8081,
            healthPath: '/api/order/health',
        });
        expect(id).toBe('order-service-h-8081');
    });

    test('deregister는 service-id로 PUT 호출', async () => {
        // GIVEN
        let called = false;
        nock(CONSUL_BASE)
            .put('/v1/agent/service/deregister/order-service-h-8081')
            .reply(200, () => { called = true; return ''; });

        // WHEN
        await deregister(CONSUL_BASE, 'order-service-h-8081');

        // THEN
        expect(called).toBe(true);
    });

    test('setupGracefulShutdown 은 SIGTERM 시 deregister 호출 후 process.exit', async () => {
        // GIVEN
        nock(CONSUL_BASE)
            .put('/v1/agent/service/deregister/order-service-h-8081')
            .reply(200);

        const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});

        // WHEN
        setupGracefulShutdown(CONSUL_BASE, 'order-service-h-8081');
        process.emit('SIGTERM');

        // 비동기 deregister 완료 대기 (axios + nock 응답 처리에 충분한 시간 부여)
        await new Promise((r) => setTimeout(r, 100));

        // THEN
        expect(exitSpy).toHaveBeenCalledWith(0);

        exitSpy.mockRestore();
        process.removeAllListeners('SIGTERM');
    });

    // ──────────────────────────────────────────────────────────────────────
    // [K8s + Consul 회고] instanceKey 옵션 (POD_NAME 주입 시나리오).
    //
    // 기존 결함: K8s replicas=2 환경에서 두 Pod 모두 host="order-service" 로
    //          serviceId="order-service-order-service-8081" 가 동일 → ID 충돌.
    // 해결: instanceKey = POD_NAME 을 넘기면 serviceId 가 replica 마다 유니크.
    // ──────────────────────────────────────────────────────────────────────

    test('instanceKey 가 주어지면 serviceId 의 인스턴스 키로 사용된다 (K8s 시나리오)', async () => {
        // GIVEN: K8s 처럼 host=POD_IP, instanceKey=POD_NAME
        let receivedBody;
        nock(CONSUL_BASE)
            .put('/v1/agent/service/register', (body) => {
                receivedBody = body;
                return true;
            })
            .reply(200);

        // WHEN
        const id = await register({
            consulUrl: CONSUL_BASE,
            name: 'order-service',
            host: '10.244.0.42',
            port: 8081,
            healthPath: '/api/order/health',
            instanceKey: 'order-service-deadbeef-x12k9',
        });

        // THEN: Address 는 host(POD_IP), serviceId 의 인스턴스 키는 POD_NAME
        expect(id).toBe('order-service-order-service-deadbeef-x12k9-8081');
        expect(receivedBody.Address).toBe('10.244.0.42');
        expect(receivedBody.Check.HTTP).toBe('http://10.244.0.42:8081/api/order/health');
    });

    test('두 Pod 의 instanceKey 가 다르면 서로 다른 serviceId 로 등록된다 (충돌 결함 회귀 차단)', async () => {
        // GIVEN: 같은 K8s Service 의 replica 2개 (POD_NAME 만 다름)
        nock(CONSUL_BASE).put('/v1/agent/service/register').reply(200);
        nock(CONSUL_BASE).put('/v1/agent/service/register').reply(200);

        // WHEN
        const id1 = await register({
            consulUrl: CONSUL_BASE,
            name: 'order-service',
            host: '10.244.0.42',
            port: 8081,
            healthPath: '/api/order/health',
            instanceKey: 'order-service-deadbeef-x12k9',
        });
        const id2 = await register({
            consulUrl: CONSUL_BASE,
            name: 'order-service',
            host: '10.244.0.43',
            port: 8081,
            healthPath: '/api/order/health',
            instanceKey: 'order-service-deadbeef-y77m2',
        });

        // THEN: 두 ID 가 다르다 (한 Pod 의 deregister 가 다른 Pod 를 건드리지 않게 됨)
        expect(id1).not.toBe(id2);
        expect(id1).toBe('order-service-order-service-deadbeef-x12k9-8081');
        expect(id2).toBe('order-service-order-service-deadbeef-y77m2-8081');
    });

    test('instanceKey 미지정이면 host 가 그대로 사용된다 (Docker Compose 호환)', async () => {
        // GIVEN: Docker Compose 처럼 instanceKey 없이 hostname 만 전달
        nock(CONSUL_BASE).put('/v1/agent/service/register').reply(200);

        // WHEN
        const id = await register({
            consulUrl: CONSUL_BASE,
            name: 'order-service',
            host: 'order-service-1',
            port: 8081,
            healthPath: '/api/order/health',
        });

        // THEN: 기존 동작 그대로 — serviceId = name-host-port
        expect(id).toBe('order-service-order-service-1-8081');
    });
});
