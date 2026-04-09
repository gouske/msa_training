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
});
