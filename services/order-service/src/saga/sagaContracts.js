/**
 * Saga 계약 상수 — Orchestrator와 참여 서비스(payment/auth)가 공유하는 "약속".
 *
 * 학습 포인트:
 *   - 큐 이름·메시지 타입을 문자열 리터럴로 흩뿌리면 오타 1글자에 메시지가 유실됩니다.
 *   - 상수로 모아 두면 양쪽 서비스가 동일한 이름을 참조하도록 강제할 수 있습니다.
 *   - (Phase 2에서 payment-service/auth-service도 동일한 이름을 사용합니다.)
 */

/** RabbitMQ 큐 이름 */
const QUEUE = Object.freeze({
    PAYMENT_COMMAND: 'saga.payment.command', // Orchestrator → payment (CHARGE/REFUND)
    POINTS_COMMAND:  'saga.points.command',  // Orchestrator → auth (EARN/CANCEL)
    REPLY:           'saga.reply',           // participant → Orchestrator
});

/** 메시지 타입 — command(명령)와 reply(응답)를 모두 포함 */
const MSG = Object.freeze({
    // command (Orchestrator가 발행)
    CHARGE: 'CHARGE',
    REFUND: 'REFUND',
    EARN:   'EARN',
    CANCEL: 'CANCEL',
    // reply (participant가 발행 → Orchestrator가 수신)
    PAYMENT_SUCCEEDED: 'PAYMENT_SUCCEEDED',
    PAYMENT_FAILED:    'PAYMENT_FAILED',
    POINTS_SUCCEEDED:  'POINTS_SUCCEEDED',
    POINTS_FAILED:     'POINTS_FAILED',
    REFUND_SUCCEEDED:  'REFUND_SUCCEEDED',
    REFUND_FAILED:     'REFUND_FAILED',
});

/** Saga 단계 이름 */
const STEP = Object.freeze({
    INVENTORY: 'T1_INVENTORY',
    PAYMENT:   'T2_PAYMENT',
    POINTS:    'T3_POINTS',
});

module.exports = { QUEUE, MSG, STEP };
