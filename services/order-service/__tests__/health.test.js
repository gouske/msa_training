/**
 * [Issue #13] Order /health 엔드포인트의 DB 연결 상태 반영 테스트
 *
 * 배경:
 *   - K8s readinessProbe / livenessProbe 가 동일한 /health 를 사용하던 구조에서
 *     MongoDB 연결 실패 시에도 200 이 반환되어 Pod 가 Ready 로 유지되는 문제가 있었음.
 *   - 이 테스트는 라우터가 DB 연결 상태를 반영해 503 을 반환하는지 검증한다.
 *
 * 설계:
 *   - createOrderRouter 에 isDbConnected 콜백을 주입할 수 있도록 확장하여
 *     실제 mongoose 연결 없이 health 동작만 격리 테스트한다.
 *   - 기본값(콜백 미주입)은 mongoose.connection.readyState === 1 을 검사한다.
 */

const request = require('supertest');
const express = require('express');

const { createOrderRouter } = require('../src/interfaces/routes/orderRoutes');

const TEST_INTERNAL_KEY = 'test-internal-key-2026';

function createTestApp(isDbConnected) {
    const app = express();
    app.use(express.json());
    const router = createOrderRouter({
        orderService: { createOrder: jest.fn(), processPaymentCallback: jest.fn() },
        internalApiKey: TEST_INTERNAL_KEY,
        isDbConnected,
    });
    app.use('/api/order', router);
    return app;
}

describe('GET /api/order/health (Issue #13)', () => {
    test('DB 연결이 살아있으면 200 + status:healthy 를 반환한다', async () => {
        const app = createTestApp(() => true);

        const response = await request(app).get('/api/order/health');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ status: 'healthy', db: 'up' });
    });

    test('DB 연결이 끊어져 있으면 503 + status:unhealthy 를 반환한다', async () => {
        const app = createTestApp(() => false);

        const response = await request(app).get('/api/order/health');

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({ status: 'unhealthy', db: 'down' });
    });

    test('isDbConnected 콜백 미주입 시 기본값(mongoose.connection.readyState===1)을 사용한다', async () => {
        // mongoose 를 require 한 시점의 connection.readyState 는 0 (disconnected) 이므로 503.
        const app = createTestApp();

        const response = await request(app).get('/api/order/health');

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({ status: 'unhealthy', db: 'down' });
    });
});
