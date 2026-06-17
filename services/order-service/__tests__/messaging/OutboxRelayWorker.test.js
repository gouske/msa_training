const { OutboxRelayWorker } = require('../../src/infrastructure/messaging/OutboxRelayWorker');

describe('OutboxRelayWorker', () => {
    let repo, publisher, worker;
    const FIXED_NOW = new Date('2026-06-17T12:00:00.000Z');

    beforeEach(() => {
        repo = {
            findWithPendingOutbox: jest.fn(),
            markOutboxSent: jest.fn().mockResolvedValue(undefined),
            incOutboxAttempt: jest.fn().mockResolvedValue(undefined),
        };
        publisher = { publish: jest.fn().mockResolvedValue(undefined) };
        worker = new OutboxRelayWorker({
            sagaRepository: repo, commandPublisher: publisher,
            stepTimeoutMs: 15000, maxOutboxAttempts: 10, now: () => FIXED_NOW,
        });
    });

    test('PENDING 엔트리만 발행하고 SENT 표시 + deadline(now+stepTimeoutMs) 무장', async () => {
        repo.findWithPendingOutbox.mockResolvedValue([
            { sagaId: 's1', outbox: [
                { id: 'e1', queue: 'saga.payment.command', message: { type: 'CHARGE', stepName: 'T2_PAYMENT' }, status: 'PENDING', attempts: 0 },
                { id: 'e2', queue: 'saga.points.command', message: { type: 'EARN' }, status: 'SENT' },
            ] },
        ]);

        await worker.tick();

        expect(publisher.publish).toHaveBeenCalledTimes(1);
        expect(publisher.publish).toHaveBeenCalledWith('saga.payment.command', { type: 'CHARGE', stepName: 'T2_PAYMENT' });
        const expectedDeadline = new Date(FIXED_NOW.getTime() + 15000);
        expect(repo.markOutboxSent).toHaveBeenCalledWith('s1', 'e1', FIXED_NOW, expectedDeadline, 'T2_PAYMENT');
        expect(repo.incOutboxAttempt).not.toHaveBeenCalled();
    });

    test('발행이 실패하면 SENT 대신 시도 횟수를 증가시킨다(다음 주기 재시도)', async () => {
        repo.findWithPendingOutbox.mockResolvedValue([
            { sagaId: 's1', outbox: [{ id: 'e1', queue: 'q1', message: {}, status: 'PENDING', attempts: 0 }] },
        ]);
        publisher.publish.mockRejectedValue(new Error('broker down'));

        await worker.tick();

        expect(repo.markOutboxSent).not.toHaveBeenCalled();
        expect(repo.incOutboxAttempt).toHaveBeenCalledWith('s1', 'e1', FIXED_NOW);
    });

    test('발행 실패가 maxOutboxAttempts 임계에 도달하면 운영자 경고를 남긴다(재시도는 계속)', async () => {
        repo.findWithPendingOutbox.mockResolvedValue([
            { sagaId: 's1', outbox: [{ id: 'e1', queue: 'q1', message: {}, status: 'PENDING', attempts: 9 }] },
        ]);
        publisher.publish.mockRejectedValue(new Error('broker down'));
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        await worker.tick();

        expect(repo.incOutboxAttempt).toHaveBeenCalledWith('s1', 'e1', FIXED_NOW); // 여전히 재시도
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('outbox 발행'));
        errSpy.mockRestore();
    });
});
