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

/** OrderServiceError.code → HTTP 상태 코드 매핑 */
const ERROR_STATUS_MAP = {
    INVALID_PAYMENT_STATUS: 400,
    ORDER_NOT_FOUND:        404,
    ORDER_ALREADY_PROCESSED: 409,
};

/**
 * @param {{ orderService: OrderService, internalApiKey: string }} deps
 * @returns {express.Router}
 */
function createOrderRouter({ orderService, internalApiKey }) {
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

        // [제20강] X-Correlation-ID 헤더를 읽어 서비스 계층으로 전달합니다.
        // 헤더가 없으면 빈 문자열 — 도메인 계층은 HTTP 헤더를 직접 알 필요가 없습니다.
        const correlationId = req.headers['x-correlation-id'] || '';

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
     * 헬스 체크
     */
    router.get('/health', (req, res) => {
        res.json({
            status: 'OK',
            message: '✅ Order Service is Running on Node.js!',
        });
    });

    return router;
}

module.exports = { createOrderRouter };
