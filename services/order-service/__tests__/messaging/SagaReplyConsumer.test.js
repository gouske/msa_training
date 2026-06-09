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
            on: jest.fn(), // 새 구현에서 channel.on('close', ...) 호출 시 필요
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

describe('SagaReplyConsumer — 재시도/재구독', () => {
    let mockChannel, mockOrchestrator;

    beforeEach(() => {
        jest.useFakeTimers();
        mockChannel = {
            assertQueue: jest.fn().mockResolvedValue(undefined),
            consume: jest.fn().mockResolvedValue(undefined),
            ack: jest.fn(),
            nack: jest.fn(),
            on: jest.fn(),
        };
        mockOrchestrator = { handleReply: jest.fn().mockResolvedValue(undefined) };
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test('start 가 실패하면 retryDelay 후 다시 시도한다', async () => {
        // RabbitMQ 미준비 상황 시뮬레이션: 1차 시도 실패 → 2차 시도 성공
        let attempt = 0;
        const channelProvider = jest.fn().mockImplementation(() => {
            attempt += 1;
            if (attempt === 1) return Promise.reject(new Error('RabbitMQ 미준비'));
            return Promise.resolve(mockChannel);
        });
        const consumer = new SagaReplyConsumer({
            channelProvider,
            orchestrator: mockOrchestrator,
            retryDelayMs: 1000,
        });

        await consumer.start(); // 1차 시도 실패 → 재시도 예약
        expect(channelProvider).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1000); // 재시도 트리거
        expect(channelProvider).toHaveBeenCalledTimes(2);
        expect(mockChannel.consume).toHaveBeenCalledWith(QUEUE.REPLY, expect.any(Function));
    });

    test('채널 close 이벤트가 오면 재구독을 예약한다', async () => {
        const channelProvider = jest.fn().mockResolvedValue(mockChannel);
        const consumer = new SagaReplyConsumer({
            channelProvider,
            orchestrator: mockOrchestrator,
            retryDelayMs: 1000,
        });

        await consumer.start();
        expect(channelProvider).toHaveBeenCalledTimes(1);

        // start 에서 등록한 close 핸들러를 꺼내 호출
        const closeHandler = mockChannel.on.mock.calls.find(([evt]) => evt === 'close')[1];
        closeHandler();

        await jest.advanceTimersByTimeAsync(1000);
        expect(channelProvider).toHaveBeenCalledTimes(2); // 재구독 시도
    });
});
