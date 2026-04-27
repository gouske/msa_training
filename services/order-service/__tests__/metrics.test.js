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
});
