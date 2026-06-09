const { QUEUE, dlqName, queueAssertOptions } = require('../../src/saga/sagaContracts');

describe('sagaContracts — DLQ 선언 헬퍼', () => {
    test('dlqName 은 큐 이름에 .dlq 를 붙인다', () => {
        expect(dlqName(QUEUE.PAYMENT_COMMAND)).toBe('saga.payment.command.dlq');
        expect(dlqName(QUEUE.REPLY)).toBe('saga.reply.dlq');
    });

    test('queueAssertOptions 는 durable + DLQ 라우팅 arguments 를 반환한다', () => {
        const opts = queueAssertOptions(QUEUE.PAYMENT_COMMAND);
        expect(opts.durable).toBe(true);
        expect(opts.arguments['x-dead-letter-exchange']).toBe('');
        expect(opts.arguments['x-dead-letter-routing-key']).toBe('saga.payment.command.dlq');
    });

    test('reply 큐 옵션도 동일 규칙을 따른다 (payment-service 와 일치)', () => {
        const opts = queueAssertOptions(QUEUE.REPLY);
        expect(opts.arguments['x-dead-letter-routing-key']).toBe('saga.reply.dlq');
    });
});
