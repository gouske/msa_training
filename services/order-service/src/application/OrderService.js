/**
 * OrderService — 애플리케이션 서비스
 *
 * 학습 포인트:
 *   - 애플리케이션 서비스는 유스케이스를 조율하는 역할을 합니다
 *   - 도메인 로직은 직접 처리하지 않고 도메인 객체(Order, OrderItem)에 위임합니다
 *   - 저장소(Repository)와 메시지 발행(MessagePublisher)을 생성자에서 주입받습니다
 *     → 테스트 시 mock 의존성을 주입하기 쉬워집니다 (의존성 역전 원칙)
 *   - OrderServiceError는 에러 유형을 code 필드로 구분하여
 *     라우터 계층에서 적절한 HTTP 상태 코드로 변환합니다
 */
const Order = require('../domain/Order');
const OrderItem = require('../domain/OrderItem');
const Money = require('../domain/Money');

/** 애플리케이션 서비스 수준 에러 — code 필드로 유형 구분 */
class OrderServiceError extends Error {
    constructor(code, message, data) {
        super(message);
        this.name = 'OrderServiceError';
        this.code = code;
        this.data = data;
    }
}

class OrderService {
    /**
     * @param {object} orderRepository - { save, findById, updateStatus }
     * @param {object} messagePublisher - { publish }
     */
    constructor(orderRepository, messagePublisher) {
        this._repo = orderRepository;
        this._publisher = messagePublisher;
    }

    /**
     * 주문 생성 유스케이스
     * 1. 도메인 객체 생성 (Order, OrderItem, Money)
     * 2. 저장소에 저장
     * 3. 결제 메시지 발행
     * @returns {{ orderId: string, status: 'PENDING' }}
     */
    async createOrder(userEmail, itemId, quantity, price) {
        const item = new OrderItem(itemId, new Money(price), quantity);
        const order = Order.create(userEmail, item);

        const orderId = await this._repo.save(order);

        await this._publisher.publish({
            orderId,
            amount: order.totalAmount().amount,
            userEmail,
        });

        return { orderId, status: 'PENDING' };
    }

    /**
     * 결제 콜백 처리 유스케이스
     * - paymentStatus: 'COMPLETED' | 'FAILED'
     * - PENDING 상태인 주문만 업데이트 (원자적 조건부 업데이트)
     * @returns {{ status: string }}
     * @throws {OrderServiceError} INVALID_PAYMENT_STATUS | ORDER_NOT_FOUND | ORDER_ALREADY_PROCESSED
     */
    async processPaymentCallback(orderId, paymentStatus) {
        const allowedStatuses = ['COMPLETED', 'FAILED'];
        if (!allowedStatuses.includes(paymentStatus)) {
            throw new OrderServiceError(
                'INVALID_PAYMENT_STATUS',
                `유효하지 않은 결제 상태: ${paymentStatus}`
            );
        }

        const newStatus = paymentStatus === 'COMPLETED' ? 'SUCCESS' : 'FAILED';
        const updated = await this._repo.updateStatus(orderId, newStatus);

        if (!updated) {
            // null 반환 = 주문이 없거나 이미 종결 상태
            const existing = await this._repo.findById(orderId);
            if (!existing) {
                throw new OrderServiceError(
                    'ORDER_NOT_FOUND',
                    `주문을 찾을 수 없습니다: ${orderId}`
                );
            }
            throw new OrderServiceError(
                'ORDER_ALREADY_PROCESSED',
                `이미 처리된 주문입니다. 현재 상태: ${existing.status}`,
                { currentStatus: existing.status }
            );
        }

        return { status: updated.status };
    }
}

module.exports = { OrderService, OrderServiceError };
