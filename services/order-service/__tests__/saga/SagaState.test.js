const { SagaState, canTransition, assertTransition } = require('../../src/saga/SagaState');

describe('SagaState 전이 규칙', () => {
    test('STARTED → INVENTORY_RESERVED 는 허용된다', () => {
        expect(canTransition(SagaState.STARTED, SagaState.INVENTORY_RESERVED)).toBe(true);
    });

    test('STARTED → FAILED 는 허용된다 (재고 부족 — 보상 불필요)', () => {
        expect(canTransition(SagaState.STARTED, SagaState.FAILED)).toBe(true);
    });

    test('INVENTORY_RESERVED → PAYMENT_CHARGED / COMPENSATING 은 허용된다', () => {
        expect(canTransition(SagaState.INVENTORY_RESERVED, SagaState.PAYMENT_CHARGED)).toBe(true);
        expect(canTransition(SagaState.INVENTORY_RESERVED, SagaState.COMPENSATING)).toBe(true);
    });

    test('PAYMENT_CHARGED → POINTS_EARNED / COMPENSATING 은 허용된다', () => {
        expect(canTransition(SagaState.PAYMENT_CHARGED, SagaState.POINTS_EARNED)).toBe(true);
        expect(canTransition(SagaState.PAYMENT_CHARGED, SagaState.COMPENSATING)).toBe(true);
    });

    test('PAYMENT_CHARGED → COMPLETED 는 허용된다 (포인트 비활성 시 직접 완료)', () => {
        expect(canTransition(SagaState.PAYMENT_CHARGED, SagaState.COMPLETED)).toBe(true);
    });

    test('POINTS_EARNED → COMPLETED 는 허용된다', () => {
        expect(canTransition(SagaState.POINTS_EARNED, SagaState.COMPLETED)).toBe(true);
    });

    test('COMPENSATING → FAILED / COMPENSATION_FAILED 는 허용된다', () => {
        expect(canTransition(SagaState.COMPENSATING, SagaState.FAILED)).toBe(true);
        expect(canTransition(SagaState.COMPENSATING, SagaState.COMPENSATION_FAILED)).toBe(true);
    });

    test('역방향/건너뛰기 전이는 거부된다', () => {
        expect(canTransition(SagaState.COMPLETED, SagaState.STARTED)).toBe(false);
        expect(canTransition(SagaState.STARTED, SagaState.PAYMENT_CHARGED)).toBe(false);
    });

    test('assertTransition 은 잘못된 전이에서 에러를 던진다', () => {
        expect(() => assertTransition(SagaState.STARTED, SagaState.COMPLETED)).toThrow();
    });

    test('assertTransition 은 허용된 전이에서 에러를 던지지 않는다', () => {
        expect(() => assertTransition(SagaState.STARTED, SagaState.INVENTORY_RESERVED)).not.toThrow();
    });
});
