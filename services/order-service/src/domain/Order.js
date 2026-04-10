/**
 * Order Aggregate Root (집합체 루트)
 *
 * 학습 포인트:
 *   - Aggregate Root는 집합체 내 모든 객체의 진입점입니다
 *   - 상태 전이 로직을 캡슐화하여 외부에서 직접 status를 변경할 수 없습니다
 *   - Order.create() 팩토리 메서드로 생성 시 유효성을 검증합니다
 *   - 상태 전이: PENDING → SUCCESS (completePayment)
 *              PENDING → FAILED  (failPayment)
 *              종결 상태(SUCCESS/FAILED)에서 다른 상태로 전이 불가
 */
const OrderStatus = require('./OrderStatus');

class Order {
    /** private 생성자 — Order.create()를 통해서만 생성 */
    constructor(userEmail, item) {
        this._userEmail = userEmail;
        this._item = item;
        this._status = OrderStatus.PENDING;
    }

    /** 팩토리 메서드: 유효성 검증 후 Order 인스턴스 반환 */
    static create(userEmail, item) {
        if (!userEmail) {
            throw new Error('사용자 이메일은 필수입니다');
        }
        return new Order(userEmail, item);
    }

    get userEmail() { return this._userEmail; }
    get item()      { return this._item; }
    get status()    { return this._status; }

    /** 아이템의 합계 금액을 Money로 반환합니다 */
    totalAmount() {
        return this._item.totalPrice();
    }

    /** 결제 성공: PENDING → SUCCESS */
    completePayment() {
        this._assertPending('결제 완료');
        this._status = OrderStatus.SUCCESS;
    }

    /** 결제 실패: PENDING → FAILED */
    failPayment() {
        this._assertPending('결제 실패');
        this._status = OrderStatus.FAILED;
    }

    /** PENDING 상태가 아니면 에러 발생 */
    _assertPending(action) {
        if (this._status !== OrderStatus.PENDING) {
            throw new Error(
                `${action} 전이는 PENDING 상태에서만 가능합니다. 현재 상태: ${this._status}`
            );
        }
    }
}

module.exports = Order;
