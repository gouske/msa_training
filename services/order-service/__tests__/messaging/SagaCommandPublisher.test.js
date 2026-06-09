const { SagaCommandPublisher } = require('../../src/infrastructure/messaging/SagaCommandPublisher');
const { QUEUE, dlqName } = require('../../src/saga/sagaContracts');

describe('SagaCommandPublisher', () => {
    let mockChannel, publisher;

    beforeEach(() => {
        mockChannel = {
            assertQueue: jest.fn().mockResolvedValue(undefined),
            sendToQueue: jest.fn(),
        };
        // channelProvider: 매번 같은 채널을 돌려주는 async 함수
        publisher = new SagaCommandPublisher(async () => mockChannel);
    });

    test('publish 는 큐와 DLQ 를 선언하고 JSON 메시지를 발행한다', async () => {
        const message = { sagaId: 's1', type: 'CHARGE', payload: { amount: 10000 } };

        await publisher.publish(QUEUE.PAYMENT_COMMAND, message);

        // DLQ 선언
        expect(mockChannel.assertQueue).toHaveBeenCalledWith(dlqName(QUEUE.PAYMENT_COMMAND), { durable: true });
        // 큐 선언 (durable + DLQ 라우팅)
        expect(mockChannel.assertQueue).toHaveBeenCalledWith(
            QUEUE.PAYMENT_COMMAND,
            expect.objectContaining({ durable: true, arguments: expect.any(Object) }),
        );
        // 메시지 발행 — JSON 직렬화된 Buffer + persistent
        const [queueArg, bufferArg, optsArg] = mockChannel.sendToQueue.mock.calls.at(-1);
        expect(queueArg).toBe(QUEUE.PAYMENT_COMMAND);
        expect(JSON.parse(bufferArg.toString())).toEqual(message);
        expect(optsArg).toEqual({ persistent: true });
    });
});
