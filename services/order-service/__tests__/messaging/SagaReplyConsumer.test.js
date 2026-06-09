const { SagaReplyConsumer } = require('../../src/infrastructure/messaging/SagaReplyConsumer');
const { QUEUE, MSG, dlqName } = require('../../src/saga/sagaContracts');

describe('SagaReplyConsumer', () => {
    let mockChannel, mockOrchestrator, consumer, consumeCallback;

    beforeEach(() => {
        mockChannel = {
            assertQueue: jest.fn().mockResolvedValue(undefined),
            consume: jest.fn().mockImplementation((queue, cb) => {
                consumeCallback = cb; // start()가 등록한 콜백을 캡처
                return Promise.resolve();
            }),
            ack: jest.fn(),
            nack: jest.fn(),
        };
        mockOrchestrator = { handleReply: jest.fn().mockResolvedValue(undefined) };
        consumer = new SagaReplyConsumer({
            channelProvider: async () => mockChannel,
            orchestrator: mockOrchestrator,
        });
    });

    /** RabbitMQ 메시지 모양으로 감싸는 헬퍼 */
    const asMsg = (obj) => ({ content: Buffer.from(JSON.stringify(obj)) });

    test('start 는 reply 큐와 DLQ 를 선언하고 구독을 시작한다', async () => {
        await consumer.start();

        expect(mockChannel.assertQueue).toHaveBeenCalledWith(dlqName(QUEUE.REPLY), { durable: true });
        expect(mockChannel.assertQueue).toHaveBeenCalledWith(QUEUE.REPLY, expect.objectContaining({ durable: true }));
        expect(mockChannel.consume).toHaveBeenCalledWith(QUEUE.REPLY, expect.any(Function));
    });

    test('reply 수신 시 handleReply 를 호출하고 ACK 한다', async () => {
        await consumer.start();
        const reply = { sagaId: 's1', type: MSG.PAYMENT_SUCCEEDED, payload: { paymentId: 'PAY-1' } };

        await consumeCallback(asMsg(reply));

        expect(mockOrchestrator.handleReply).toHaveBeenCalledWith(reply);
        expect(mockChannel.ack).toHaveBeenCalledTimes(1);
        expect(mockChannel.nack).not.toHaveBeenCalled();
    });

    test('처리 중 예외가 나면 NACK(requeue=false) 로 DLQ 격리한다', async () => {
        mockOrchestrator.handleReply.mockRejectedValueOnce(new Error('boom'));
        await consumer.start();

        await consumeCallback(asMsg({ sagaId: 's1', type: MSG.PAYMENT_SUCCEEDED }));

        expect(mockChannel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
        expect(mockChannel.ack).not.toHaveBeenCalled();
    });

    test('null 메시지(consumer 취소)는 무시한다', async () => {
        await consumer.start();
        await consumeCallback(null);
        expect(mockOrchestrator.handleReply).not.toHaveBeenCalled();
    });
});
