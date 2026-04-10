/**
 * [TDD - RED] Order Aggregate Root 테스트
 *
 * 학습 포인트:
 *   - Order는 Aggregate Root로, 주문의 상태 전이를 캡슐화합니다
 *   - 외부에서 status를 직접 변경할 수 없고, completePayment()/failPayment()를 통해서만 전이 가능
 *   - 상태 전이 규칙: PENDING → SUCCESS / PENDING → FAILED 만 허용 (종결 상태에서 변경 불가)
 *   - Order.create() 팩토리 메서드로 생성 (유효성 검증 포함)
 */

const Order = require('../../src/domain/Order');
const OrderItem = require('../../src/domain/OrderItem');
const Money = require('../../src/domain/Money');
const OrderStatus = require('../../src/domain/OrderStatus');

describe('Order (Aggregate Root)', () => {

    // 테스트용 유효한 OrderItem 생성 헬퍼
    function makeItem(price = 5000, quantity = 3) {
        return new OrderItem('PROD-001', new Money(price), quantity);
    }

    // --- 생성 규칙 ---

    test('유효한 이메일과 아이템으로 생성하면 PENDING 상태로 시작한다', () => {
        const order = Order.create('buyer@test.com', makeItem());
        expect(order.userEmail).toBe('buyer@test.com');
        expect(order.status).toBe(OrderStatus.PENDING);
    });

    test('사용자 이메일이 없으면 에러가 발생한다', () => {
        expect(() => Order.create('', makeItem())).toThrow();
    });

    test('사용자 이메일이 null이면 에러가 발생한다', () => {
        expect(() => Order.create(null, makeItem())).toThrow();
    });

    // --- 상태 전이: PENDING → SUCCESS ---

    test('completePayment()는 PENDING → SUCCESS로 전이한다', () => {
        const order = Order.create('buyer@test.com', makeItem());
        order.completePayment();
        expect(order.status).toBe(OrderStatus.SUCCESS);
    });

    // --- 상태 전이: PENDING → FAILED ---

    test('failPayment()는 PENDING → FAILED로 전이한다', () => {
        const order = Order.create('buyer@test.com', makeItem());
        order.failPayment();
        expect(order.status).toBe(OrderStatus.FAILED);
    });

    // --- 종결 상태에서 변경 불가 (불변 전이 규칙) ---

    test('SUCCESS 상태에서 completePayment()를 호출하면 에러가 발생한다', () => {
        const order = Order.create('buyer@test.com', makeItem());
        order.completePayment();
        expect(() => order.completePayment()).toThrow();
    });

    test('SUCCESS 상태에서 failPayment()를 호출하면 에러가 발생한다', () => {
        const order = Order.create('buyer@test.com', makeItem());
        order.completePayment();
        expect(() => order.failPayment()).toThrow();
    });

    test('FAILED 상태에서 failPayment()를 호출하면 에러가 발생한다', () => {
        const order = Order.create('buyer@test.com', makeItem());
        order.failPayment();
        expect(() => order.failPayment()).toThrow();
    });

    test('FAILED 상태에서 completePayment()를 호출하면 에러가 발생한다', () => {
        const order = Order.create('buyer@test.com', makeItem());
        order.failPayment();
        expect(() => order.completePayment()).toThrow();
    });

    // --- 금액 계산 ---

    test('totalAmount()는 아이템의 합계 금액(단가 × 수량)을 반환한다', () => {
        const order = Order.create('buyer@test.com', makeItem(5000, 3));
        expect(order.totalAmount().amount).toBe(15000);
    });
});
