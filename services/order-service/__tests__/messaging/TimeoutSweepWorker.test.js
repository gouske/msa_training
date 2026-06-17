const { TimeoutSweepWorker } = require('../../src/infrastructure/messaging/TimeoutSweepWorker');

describe('TimeoutSweepWorker', () => {
    let repo, orchestrator, worker;
    const FIXED_NOW = new Date('2026-06-17T12:00:00.000Z');

    beforeEach(() => {
        repo = { findTimedOut: jest.fn().mockResolvedValue([]) };
        orchestrator = { handleTimeout: jest.fn().mockResolvedValue(undefined) };
        worker = new TimeoutSweepWorker({
            sagaRepository: repo, orchestrator, intervalMs: 5000, batchSize: 20, now: () => FIXED_NOW,
        });
    });

    test('deadline 초과 saga 를 조회해 각각 orchestrator.handleTimeout 으로 위임한다', async () => {
        const s1 = { sagaId: 's1', state: 'STARTED' };
        const s2 = { sagaId: 's2', state: 'COMPENSATING' };
        repo.findTimedOut.mockResolvedValue([s1, s2]);

        await worker.tick();

        expect(repo.findTimedOut).toHaveBeenCalledWith(FIXED_NOW, 20);
        expect(orchestrator.handleTimeout).toHaveBeenCalledTimes(2);
        expect(orchestrator.handleTimeout).toHaveBeenNthCalledWith(1, s1);
        expect(orchestrator.handleTimeout).toHaveBeenNthCalledWith(2, s2);
    });

    test('대상이 없으면 handleTimeout 을 호출하지 않는다', async () => {
        await worker.tick();
        expect(orchestrator.handleTimeout).not.toHaveBeenCalled();
    });

    test('start/stop 으로 타이머를 켜고 끈다(중복 start 무시)', () => {
        worker.start();
        const first = worker._timer;
        worker.start(); // 중복 — 무시
        expect(worker._timer).toBe(first);
        worker.stop();
        expect(worker._timer).toBeNull();
    });
});
