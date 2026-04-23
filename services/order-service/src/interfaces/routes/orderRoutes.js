/**
 * orderRoutes — Express 라우터 팩토리
 *
 * 학습 포인트:
 *   - 팩토리 함수 패턴: 의존성(orderService, internalApiKey)을 주입받아 라우터를 생성합니다
 *     → 테스트 시 mock orderService를 주입하기 쉬워집니다
 *   - 라우터는 HTTP 계층(요청 파싱, 응답 직렬화)만 담당합니다
 *     비즈니스 로직은 orderService에 완전히 위임합니다
 *   - error.code 기반 에러 핸들링:
 *     OrderServiceError의 code 필드를 HTTP 상태 코드로 매핑합니다
 *     (OrderServiceError를 import하지 않아 순환 의존 위험을 피합니다)
 */
const express = require('express');
const mongoose = require('mongoose');
const { normalizeCorrelationId } = require('../../utils/correlationId');

/** OrderServiceError.code → HTTP 상태 코드 매핑 */
const ERROR_STATUS_MAP = {
    INVALID_PAYMENT_STATUS: 400,
    ORDER_NOT_FOUND:        404,
    ORDER_ALREADY_PROCESSED: 409,
};

/**
 * mongoose 의 readyState 의미 (참고용 상수):
 *   0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
 * /health 는 1(connected) 만 정상으로 본다.
 */
const MONGOOSE_CONNECTED = 1;

/**
 * [Issue #13] /health 의 기본 DB 상태 검사기.
 * mongoose 의 전역 connection 객체를 그대로 참조하여 K8s probe 가
 * 실제 Mongo 연결 상태를 반영하도록 한다.
 */
function defaultIsDbConnected() {
    return mongoose.connection.readyState === MONGOOSE_CONNECTED;
}

/**
 * @param {object} deps
 * @param {OrderService} deps.orderService 비즈니스 서비스
 * @param {string} deps.internalApiKey Payment Service 와 공유하는 내부 키
 * @param {() => boolean} [deps.isDbConnected] DB 연결 상태 검사기.
 *   미주입 시 mongoose.connection.readyState === 1 을 기본 사용한다.
 *   테스트에서는 격리를 위해 명시적으로 주입한다.
 * @returns {express.Router}
 */
function createOrderRouter({ orderService, internalApiKey, isDbConnected = defaultIsDbConnected }) {
    const router = express.Router();

    /**
     * POST /api/order
     * 주문 생성 — Gateway가 JWT 검증 후 X-User-Email 헤더를 주입합니다
     */
    router.post('/', async (req, res) => {
        const userEmail = req.headers['x-user-email'];

        // 방어적 검사: Gateway를 거치지 않고 직접 접근한 경우
        if (!userEmail) {
            return res.status(401).json({
                message: '인증 정보가 없습니다. Gateway를 통해 접근해주세요. (X-User-Email 헤더 누락)',
            });
        }

        // [제20강 / Issue #8] X-Correlation-ID 헤더 검증 후 서비스 계층으로 전달.
        // Gateway 가 1차 검증을 하지만, 내부 우회 경로(Order 직접 호출) 시 부정 입력을
        // 차단하기 위해 defense in depth 로 한 번 더 정규화한다.
        const correlationId = normalizeCorrelationId(req.headers['x-correlation-id']);

        const { itemId, quantity, price } = req.body;
        try {
            const result = await orderService.createOrder(userEmail, itemId, quantity, price, correlationId);
            return res.status(202).json({
                message: '주문이 접수되었습니다. 결제가 백그라운드에서 처리됩니다.',
                ...result,
            });
        } catch (error) {
            return res.status(500).json({
                message: '주문 처리 중 오류가 발생했습니다.',
                error: error.message,
            });
        }
    });

    /**
     * POST /api/order/callback
     * 결제 결과 콜백 — Payment Service가 내부 키와 함께 호출합니다
     */
    router.post('/callback', async (req, res) => {
        // 내부 API 키 검증 — Payment Service만 알고 있는 키
        const internalKey = req.headers['x-internal-key'];
        if (internalKey !== internalApiKey) {
            return res.status(403).json({
                message: '내부 서비스 인증 실패 (X-Internal-Key 불일치)',
            });
        }

        const { orderId, paymentStatus } = req.body;
        try {
            const result = await orderService.processPaymentCallback(orderId, paymentStatus);
            return res.status(200).json({
                message: '주문 상태 업데이트 완료',
                status: result.status,
            });
        } catch (error) {
            // OrderServiceError.code → HTTP 상태 코드 변환
            if (error.code && ERROR_STATUS_MAP[error.code]) {
                return res.status(ERROR_STATUS_MAP[error.code]).json({
                    message: error.message,
                    ...(error.data || {}),
                });
            }
            return res.status(500).json({
                message: '주문 상태 업데이트 오류',
                error: error.message,
            });
        }
    });

    /**
     * GET /api/order/health
     * [Issue #13] DB 연결 상태를 반영하는 헬스 체크.
     *
     * 이전: 항상 200 OK 를 반환 → MongoDB 가 죽어도 K8s readinessProbe 는 Ready 로 유지됨.
     * 현재: isDbConnected() 가 false 면 503 → Pod 가 NotReady 로 마킹돼 트래픽이 격리된다.
     *
     * 주의: liveness 와 readiness 가 같은 엔드포인트를 공유하면
     *      DB 일시 단절 시 Pod 가 재시작될 수 있다. 운영 매니페스트는
     *      liveness 는 단순한 프로세스 생존 검사로, readiness 는 본 엔드포인트로
     *      분리하는 것을 권장한다 (k8s/order-service.yaml 참고).
     */
    router.get('/health', (req, res) => {
        if (!isDbConnected()) {
            return res.status(503).json({
                status: 'unhealthy',
                db: 'down',
                message: 'MongoDB 연결이 끊어져 있어 요청을 처리할 수 없습니다.',
            });
        }
        return res.status(200).json({
            status: 'healthy',
            db: 'up',
            message: '✅ Order Service is Running on Node.js!',
        });
    });

    return router;
}

module.exports = { createOrderRouter };
