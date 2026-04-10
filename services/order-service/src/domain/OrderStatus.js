/**
 * OrderStatus 열거형 (Enumeration)
 *
 * 학습 포인트:
 *   - Object.freeze()로 외부에서 값을 변경할 수 없는 열거형을 만듭니다
 *   - TypeScript의 enum 대신 JS에서 자주 사용하는 패턴입니다
 *   - 상태 전이 규칙: PENDING → SUCCESS / PENDING → FAILED 만 허용
 */
const OrderStatus = Object.freeze({
    PENDING: 'PENDING',
    SUCCESS: 'SUCCESS',
    FAILED:  'FAILED',
});

module.exports = OrderStatus;
