const { OutboxRelayWorker } = require('../../src/infrastructure/messaging/OutboxRelayWorker');

describe('OutboxRelayWorker', () => {
    let repo, publisher, worker;

    beforeEach(() => {
        repo = {
            findWithPendingOutbox: jest.fn(),
            markOutboxSent: jest.fn().mockResolvedValue(undefined),
            incOutboxAttempt: jest.fn().mockResolvedValue(undefined),
        };
        publisher = { publish: jest.fn().mockResolvedValue(undefined) };
        worker = new OutboxRelayWorker({ sagaRepository: repo, commandPublisher: publisher });
    });

    test('PENDING 엔트리만 발행하고 SENT 로 표시한다(SENT 는 건너뜀)', async () => {
        repo.findWithPendingOutbox.mockResolvedValue([
            { sagaId: 's1', outbox: [
                { id: 'e1', queue: 'saga.payment.command', message: { type: 'CHARGE' }, status: 'PENDING' },
                { id: 'e2', queue: 'saga.points.command', message: { type: 'EARN' }, status: 'SENT' },
            ] },
        ]);

        await worker.tick();

        expect(publisher.publish).toHaveBeenCalledTimes(1);
        expect(publisher.publish).toHaveBeenCalledWith('saga.payment.command', { type: 'CHARGE' });
        expect(repo.markOutboxSent).toHaveBeenCalledWith('s1', 'e1', expect.any(Date));
        expect(repo.incOutboxAttempt).not.toHaveBeenCalled();
    });

    test('발행이 실패하면 SENT 표시 대신 시도 횟수를 증가시킨다(다음 주기 재시도)', async () => {
        repo.findWithPendingOutbox.mockResolvedValue([
            { sagaId: 's1', outbox: [{ id: 'e1', queue: 'q1', message: {}, status: 'PENDING' }] },
        ]);
        publisher.publish.mockRejectedValue(new Error('broker down'));

        await worker.tick();

        expect(repo.markOutboxSent).not.toHaveBeenCalled();
        expect(repo.incOutboxAttempt).toHaveBeenCalledWith('s1', 'e1', expect.any(Date));
    });
});
