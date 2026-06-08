/**
 * Saga 상태 + 전이 규칙
 *
 * 학습 포인트:
 *   - 상태머신은 "허용된 전이"만 명시하고 나머지는 모두 거부합니다.
 *   - 잘못된 전이를 코드 곳곳에서 if 로 막는 대신, 전이표 한 곳에서 강제합니다.
 *   - 중복/순서가 뒤바뀐 메시지로 인한 비정상 전이를 조기에 차단합니다.
 */
const SagaState = Object.freeze({
    STARTED:             'STARTED',
    INVENTORY_RESERVED:  'INVENTORY_RESERVED',
    PAYMENT_CHARGED:     'PAYMENT_CHARGED',
    POINTS_EARNED:       'POINTS_EARNED',
    COMPLETED:           'COMPLETED',
    COMPENSATING:        'COMPENSATING',
    FAILED:              'FAILED',
    COMPENSATION_FAILED: 'COMPENSATION_FAILED',
});

/** 각 상태에서 갈 수 있는 다음 상태 목록 */
const TRANSITIONS = Object.freeze({
    [SagaState.STARTED]:             [SagaState.INVENTORY_RESERVED, SagaState.FAILED],
    [SagaState.INVENTORY_RESERVED]:  [SagaState.PAYMENT_CHARGED, SagaState.COMPENSATING],
    [SagaState.PAYMENT_CHARGED]:     [SagaState.POINTS_EARNED, SagaState.COMPENSATING],
    [SagaState.POINTS_EARNED]:       [SagaState.COMPLETED],
    [SagaState.COMPENSATING]:        [SagaState.FAILED, SagaState.COMPENSATION_FAILED],
    [SagaState.COMPLETED]:           [],
    [SagaState.FAILED]:              [],
    [SagaState.COMPENSATION_FAILED]: [],
});

/** from → to 전이가 허용되는지 여부 */
function canTransition(from, to) {
    const allowed = TRANSITIONS[from] || [];
    return allowed.includes(to);
}

/** 허용되지 않는 전이면 에러를 던진다 */
function assertTransition(from, to) {
    if (!canTransition(from, to)) {
        throw new Error(`잘못된 Saga 상태 전이: ${from} → ${to}`);
    }
}

module.exports = { SagaState, canTransition, assertTransition };
