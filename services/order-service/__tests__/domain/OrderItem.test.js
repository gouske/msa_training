/**
 * [TDD - RED] OrderItem 값 객체 테스트
 *
 * 학습 포인트:
 *   - OrderItem은 "상품 ID + 단가(Money) + 수량"을 묶은 값 객체입니다
 *   - 생성 시 유효성을 스스로 검증합니다 (자기 검증)
 *   - totalPrice()는 단가 × 수량을 Money로 반환합니다
 */

const OrderItem = require('../../src/domain/OrderItem');
const Money = require('../../src/domain/Money');

describe('OrderItem (값 객체)', () => {

    // 테스트용 유효한 파라미터
    const VALID_PRODUCT_ID = 'PROD-001';
    const VALID_UNIT_PRICE = new Money(5000);
    const VALID_QUANTITY = 3;

    // --- 생성 규칙 ---

    test('상품 ID, 단가, 수량으로 생성할 수 있다', () => {
        const item = new OrderItem(VALID_PRODUCT_ID, VALID_UNIT_PRICE, VALID_QUANTITY);
        expect(item.productId).toBe(VALID_PRODUCT_ID);
        expect(item.unitPrice.amount).toBe(5000);
        expect(item.quantity).toBe(VALID_QUANTITY);
    });

    test('상품 ID가 빈 문자열이면 에러가 발생한다', () => {
        expect(() => new OrderItem('', VALID_UNIT_PRICE, VALID_QUANTITY)).toThrow();
    });

    test('수량이 0이면 에러가 발생한다', () => {
        expect(() => new OrderItem(VALID_PRODUCT_ID, VALID_UNIT_PRICE, 0)).toThrow();
    });

    test('수량이 음수면 에러가 발생한다', () => {
        expect(() => new OrderItem(VALID_PRODUCT_ID, VALID_UNIT_PRICE, -1)).toThrow();
    });

    // --- 비즈니스 로직 ---

    test('totalPrice()는 단가 × 수량을 Money 객체로 반환한다', () => {
        const item = new OrderItem(VALID_PRODUCT_ID, new Money(5000), 3);
        expect(item.totalPrice().amount).toBe(15000);
    });

    test('totalPrice()는 새 Money 객체를 반환한다 (불변성)', () => {
        const item = new OrderItem(VALID_PRODUCT_ID, new Money(5000), 3);
        const total = item.totalPrice();
        expect(total).not.toBe(item.unitPrice); // 새 객체임을 확인
    });
});
