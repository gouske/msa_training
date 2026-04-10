/**
 * [TDD - RED] Money 값 객체 테스트
 *
 * 학습 포인트:
 *   - 값 객체(Value Object)는 식별자 없이 '값'으로 동등성을 판단합니다
 *   - 불변성: 연산 결과는 항상 새 Money 객체를 반환합니다
 *   - 자기 검증: 생성자에서 유효하지 않은 값을 즉시 거부합니다
 */

const Money = require('../../src/domain/Money');

describe('Money (값 객체)', () => {

    // --- 생성 규칙 ---

    test('양수 금액으로 생성할 수 있다', () => {
        const money = new Money(1000);
        expect(money.amount).toBe(1000);
    });

    test('0원으로 생성하면 에러가 발생한다', () => {
        expect(() => new Money(0)).toThrow();
    });

    test('음수 금액으로 생성하면 에러가 발생한다', () => {
        expect(() => new Money(-100)).toThrow();
    });

    // --- 연산 (불변성) ---

    test('add()는 두 Money를 더한 새 객체를 반환한다', () => {
        const a = new Money(1000);
        const b = new Money(2000);
        expect(a.add(b).amount).toBe(3000);
    });

    test('add() 후 원본 객체는 변경되지 않는다 (불변성)', () => {
        const a = new Money(1000);
        const b = new Money(2000);
        a.add(b);
        expect(a.amount).toBe(1000); // 원본은 그대로
    });

    test('multipliedBy()는 단가 × 수량을 반환한다', () => {
        const price = new Money(5000);
        expect(price.multipliedBy(3).amount).toBe(15000);
    });

    // --- 동등성 비교 ---
    // 값 객체는 참조가 아닌 값으로 비교합니다 (equals 패턴)

    test('같은 금액이면 equals()가 true를 반환한다', () => {
        expect(new Money(1000).equals(new Money(1000))).toBe(true);
    });

    test('다른 금액이면 equals()가 false를 반환한다', () => {
        expect(new Money(1000).equals(new Money(2000))).toBe(false);
    });
});
