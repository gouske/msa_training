/**
 * Money 값 객체 (Value Object)
 *
 * 학습 포인트:
 *   - 값 객체는 식별자 없이 '값'으로 동등성을 판단합니다
 *   - Object.freeze()로 불변성을 강제합니다
 *   - 연산(add, multipliedBy)은 항상 새 Money 인스턴스를 반환합니다
 *   - 생성자에서 유효하지 않은 값을 즉시 거부합니다 (자기 검증)
 */
class Money {
    constructor(amount) {
        if (amount <= 0) {
            throw new Error(`금액은 양수여야 합니다: ${amount}`);
        }
        this._amount = amount;
        Object.freeze(this); // 생성 후 변경 불가
    }

    get amount() {
        return this._amount;
    }

    /** 두 Money를 더한 새 Money를 반환합니다 */
    add(other) {
        return new Money(this._amount + other._amount);
    }

    /** 단가 × 수량을 새 Money로 반환합니다 */
    multipliedBy(multiplier) {
        return new Money(this._amount * multiplier);
    }

    /** 값 기반 동등성 비교 */
    equals(other) {
        return this._amount === other._amount;
    }
}

module.exports = Money;
