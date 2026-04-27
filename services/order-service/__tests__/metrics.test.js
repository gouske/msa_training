/**
 * [제24강] Prometheus 메트릭 모듈 테스트
 *
 * 검증 시나리오:
 *   1. metricsHandler 가 Prometheus exposition 형식 (text/plain; version=0.0.4) 으로 응답한다
 *   2. metricsMiddleware 가 정상 응답에 대해 Counter 와 Histogram 을 모두 갱신한다
 *   3. 동일 (method, route, status_code) 조합 요청은 카운터가 누적된다
 *   4. 라우트가 매칭되지 않은 요청도 노출 — 단, route 라벨은 정규화 (cardinality 폭발 방지)
 *   5. /metrics 엔드포인트 자체는 메트릭에서 제외 (관측 부트스트랩 루프 방지)
 */

const request = require('supertest');
const express = require('express');
const client = require('prom-client');

const { createMetrics } = require('../src/infrastructure/metrics');

function newApp() {
    // 격리된 registry 를 매 테스트마다 새로 생성 — Counter 누적이 테스트 간에 누수되지 않도록.
    const registry = new client.Registry();
    const metrics = createMetrics({ registry, serviceName: 'order-service-test' });

    const app = express();
    app.use(metrics.middleware);
    // /api/order/metrics 는 /:id 보다 먼저 등록되어야 한다 — 운영 index.js 도 동일 순서.
    // (Express 는 정적 경로 우선순위 없이 등록 순서대로 매칭)
    app.get('/api/order/metrics', metrics.handler);
    app.get('/api/order/health', (req, res) => res.status(200).json({ status: 'ok' }));
    app.get('/api/order/:id', (req, res) => res.status(200).json({ id: req.params.id }));

    return { app, registry, metrics };
}

describe('[제24강] metrics 모듈', () => {

    test('GET /api/order/metrics 가 Prometheus exposition 형식으로 응답한다', async () => {
        const { app } = newApp();

        const res = await request(app).get('/api/order/metrics');

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/plain/);
        expect(res.text).toContain('http_requests_total');
        expect(res.text).toContain('http_request_duration_seconds');
    });

    test('정상 요청 후 http_requests_total 가 1 증가한다', async () => {
        const { app, registry } = newApp();

        await request(app).get('/api/order/health');

        const counter = await registry.getSingleMetricAsString('http_requests_total');
        expect(counter).toMatch(
            /http_requests_total\{[^}]*method="GET"[^}]*route="\/api\/order\/health"[^}]*status_code="200"[^}]*\}\s+1/
        );
    });

    test('동일 (method, route, status_code) 요청 3회는 카운터가 3 으로 누적된다', async () => {
        const { app, registry } = newApp();

        await request(app).get('/api/order/health');
        await request(app).get('/api/order/health');
        await request(app).get('/api/order/health');

        const counter = await registry.getSingleMetricAsString('http_requests_total');
        expect(counter).toMatch(
            /http_requests_total\{[^}]*route="\/api\/order\/health"[^}]*status_code="200"[^}]*\}\s+3/
        );
    });

    test('파라미터화된 라우트는 패턴(/api/order/:id)으로 정규화된다 — cardinality 폭발 방지', async () => {
        const { app, registry } = newApp();

        await request(app).get('/api/order/abc');
        await request(app).get('/api/order/xyz');

        const counter = await registry.getSingleMetricAsString('http_requests_total');
        // 두 요청이 같은 라벨로 묶여 카운터가 2 가 되어야 한다.
        expect(counter).toMatch(
            /http_requests_total\{[^}]*route="\/api\/order\/:id"[^}]*\}\s+2/
        );
        // raw 경로가 라벨로 새지 않아야 한다.
        expect(counter).not.toMatch(/route="\/api\/order\/abc"/);
        expect(counter).not.toMatch(/route="\/api\/order\/xyz"/);
    });

    test('GET /metrics 자체는 메트릭에서 제외한다 — 관측 부트스트랩 루프 방지', async () => {
        const { app, registry } = newApp();

        await request(app).get('/api/order/metrics');
        await request(app).get('/api/order/metrics');

        const counter = await registry.getSingleMetricAsString('http_requests_total');
        // /metrics 호출은 카운터에 잡히지 않아야 한다.
        expect(counter).not.toMatch(/route="\/api\/order\/metrics"/);
    });

    test('http_request_duration_seconds 히스토그램이 기록된다', async () => {
        const { app, registry } = newApp();

        await request(app).get('/api/order/health');

        const histogram = await registry.getSingleMetricAsString('http_request_duration_seconds');
        expect(histogram).toContain('http_request_duration_seconds_bucket');
        expect(histogram).toContain('http_request_duration_seconds_count');
        expect(histogram).toContain('http_request_duration_seconds_sum');
        expect(histogram).toMatch(
            /http_request_duration_seconds_count\{[^}]*route="\/api\/order\/health"[^}]*\}\s+1/
        );
    });

    /**
     * [Codex finding #3 반영] 정상 응답 후 finish 와 close 가 모두 발생해도 카운터는 1 증가.
     * Express/Node 에서 finish 후 close 가 자동으로 따라오므로, once-guard 가 없으면 중복 카운트된다.
     */
    test('finish 와 close 가 함께 발생해도 카운터는 한 번만 증가한다 (once guard)', (done) => {
        const registry = new client.Registry();
        const metrics = createMetrics({ registry, serviceName: 'order-service-test' });

        // express 없이 raw req/res 를 시뮬레이션 — finish + close 가 모두 호출되도록.
        const req = { method: 'GET', path: '/x', route: { path: '/x' }, baseUrl: '' };
        const res = (() => {
            const handlers = { finish: [], close: [] };
            return {
                statusCode: 200,
                writableEnded: true, // 정상 응답 — Node 가 res.end() 시 true 로 세팅
                on(event, fn) { (handlers[event] || (handlers[event] = [])).push(fn); },
                _emit(event) { (handlers[event] || []).forEach(fn => fn()); },
            };
        })();

        metrics.middleware(req, res, () => {
            res._emit('finish');
            res._emit('close'); // finish 직후 close — Node 표준 동작

            registry.getSingleMetricAsString('http_requests_total').then((counter) => {
                expect(counter).toMatch(
                    /http_requests_total\{[^}]*route="\/x"[^}]*status_code="200"[^}]*\}\s+1/
                );
                done();
            });
        });
    });

    /**
     * [Codex finding #3 반영] 클라이언트 중단 / upstream 타임아웃 — finish 없이 close 만 발생.
     * 이 경우에도 카운터/히스토그램이 기록되어야 장애 시 실패 트래픽이 그래프에서 사라지지 않는다.
     * status_code 는 0 으로 라벨링 — "응답이 정상 종료되지 않음" 을 표현.
     */
    /**
     * [Codex finding #2 반영] 의존성(예: MongoDB) 연결 상태를 별도 gauge 로 노출.
     * Prometheus 의 `up` 메트릭은 scrape 성공 여부만 보여주므로, DB 가 죽어 /health=503 인 경우에도
     * /metrics 자체가 200 이면 up=1 로 보인다. 운영자가 진짜 health 를 보려면 별도 신호가 필요하다.
     */
    test('service_dependency_ready gauge — setReady(true) 후 1, false 후 0', async () => {
        const { metrics, registry } = newApp();

        // 초기값은 미설정 — 명시적으로 한쪽으로 세팅하기 전까지는 시계열이 없을 수 있다.
        metrics.dependencies.setReady('mongodb', true);
        let exported = await registry.getSingleMetricAsString('service_dependency_ready');
        expect(exported).toMatch(/service_dependency_ready\{[^}]*dependency="mongodb"[^}]*\}\s+1/);

        metrics.dependencies.setReady('mongodb', false);
        exported = await registry.getSingleMetricAsString('service_dependency_ready');
        expect(exported).toMatch(/service_dependency_ready\{[^}]*dependency="mongodb"[^}]*\}\s+0/);
    });

    test('aborted 요청 (close 만 발생, finish 없음) 도 status_code=0 으로 카운트된다', (done) => {
        const registry = new client.Registry();
        const metrics = createMetrics({ registry, serviceName: 'order-service-test' });

        const req = { method: 'GET', path: '/y', route: { path: '/y' }, baseUrl: '' };
        const res = (() => {
            const handlers = { finish: [], close: [] };
            return {
                statusCode: 0, // 응답 미전송 — Node 가 0 으로 두는 케이스 가정
                on(event, fn) { (handlers[event] || (handlers[event] = [])).push(fn); },
                _emit(event) { (handlers[event] || []).forEach(fn => fn()); },
            };
        })();

        metrics.middleware(req, res, () => {
            // finish 없이 close 만 발생 (클라이언트가 도중에 끊은 케이스)
            res._emit('close');

            registry.getSingleMetricAsString('http_requests_total').then((counter) => {
                expect(counter).toMatch(
                    /http_requests_total\{[^}]*route="\/y"[^}]*status_code="0"[^}]*\}\s+1/
                );
                done();
            });
        });
    });
});
