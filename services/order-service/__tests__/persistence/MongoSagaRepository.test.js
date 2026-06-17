const mem = require('../helpers/mongoMemory');
const SagaModel = require('../../models/Saga');
const MongoSagaRepository = require('../../src/infrastructure/persistence/MongoSagaRepository');

describe('MongoSagaRepository — compareAndAdvance (CAS + outbox)', () => {
    const repo = new MongoSagaRepository();

    beforeAll(mem.connect);
    afterEach(mem.clear);
    afterAll(mem.close);

    const seed = () => repo.save({
        sagaId: 's1', orderId: 'order-1', state: 'INVENTORY_RESERVED', currentStep: 'T2_PAYMENT',
        steps: [
            { name: 'T1_INVENTORY', status: 'DONE',    payload: { itemId: 'ITEM-1', quantity: 2 } },
            { name: 'T2_PAYMENT',   status: 'PENDING', payload: { orderId: 'order-1', amount: 100 } },
        ],
        outbox: [],
    });

    test('from 상태가 일치하면 전이하고 step 갱신 + outbox PENDING 적재 후 문서를 반환한다', async () => {
        await seed();

        const result = await repo.compareAndAdvance('s1', {
            from: 'INVENTORY_RESERVED',
            to: 'PAYMENT_CHARGED',
            currentStep: 'T3_POINTS',
            steps: [{ name: 'T2_PAYMENT', status: 'DONE', replyData: { paymentId: 'PAY-1' } }],
            outbox: [{ queue: 'saga.points.command', message: { type: 'EARN' } }],
        });

        expect(result).not.toBeNull();
        expect(result.state).toBe('PAYMENT_CHARGED');
        expect(result.currentStep).toBe('T3_POINTS');
        const payStep = result.steps.find((s) => s.name === 'T2_PAYMENT');
        expect(payStep.status).toBe('DONE');
        expect(payStep.replyData).toEqual({ paymentId: 'PAY-1' });
        expect(result.outbox).toHaveLength(1);
        expect(result.outbox[0]).toMatchObject({ queue: 'saga.points.command', status: 'PENDING', attempts: 0 });
        expect(typeof result.outbox[0].id).toBe('string');
    });

    test('from 상태가 일치하지 않으면 null 을 반환하고 아무것도 바꾸지 않는다 (CAS 패배)', async () => {
        await seed();

        const result = await repo.compareAndAdvance('s1', {
            from: 'PAYMENT_CHARGED', // 실제 상태는 INVENTORY_RESERVED 라 불일치
            to: 'POINTS_EARNED',
        });

        expect(result).toBeNull();
        const saga = await repo.findBySagaId('s1');
        expect(saga.state).toBe('INVENTORY_RESERVED'); // 불변
        expect(saga.outbox).toHaveLength(0);
    });

    test('같은 from 으로 두 번 동시에 호출하면 정확히 한 번만 성공한다 (L3 동시성 핵심)', async () => {
        await seed();

        const [a, b] = await Promise.all([
            repo.compareAndAdvance('s1', { from: 'INVENTORY_RESERVED', to: 'COMPENSATING', steps: [{ name: 'T2_PAYMENT', status: 'FAILED' }] }),
            repo.compareAndAdvance('s1', { from: 'INVENTORY_RESERVED', to: 'COMPENSATING', steps: [{ name: 'T2_PAYMENT', status: 'FAILED' }] }),
        ]);

        const winners = [a, b].filter((r) => r !== null);
        expect(winners).toHaveLength(1); // 단 하나의 처리자만 전이에 성공
    });
});

describe('MongoSagaRepository — outbox 발행 표시(markOutboxSent/incOutboxAttempt)', () => {
    const repo = new MongoSagaRepository();

    beforeAll(mem.connect);
    afterEach(mem.clear);
    afterAll(mem.close);

    const seedWithOutbox = (entries) => repo.save({
        sagaId: 's-out', orderId: 'o', state: 'INVENTORY_RESERVED', steps: [], outbox: entries,
    });

    test('여러 PENDING 중 지정한 id 만 SENT 로 바뀐다 (positional 오타겟 방지)', async () => {
        await seedWithOutbox([
            { id: 'A', queue: 'q', message: { n: 1 }, status: 'PENDING', attempts: 0, lastAttemptAt: null },
            { id: 'B', queue: 'q', message: { n: 2 }, status: 'PENDING', attempts: 0, lastAttemptAt: null },
        ]);

        await repo.markOutboxSent('s-out', 'B', new Date());

        const saga = await repo.findBySagaId('s-out');
        expect(saga.outbox.find((e) => e.id === 'B').status).toBe('SENT');   // 지정한 B 만
        expect(saga.outbox.find((e) => e.id === 'A').status).toBe('PENDING'); // A 는 영향 없음
    });

    test('이미 SENT 인 엔트리에 다시 호출해도 다른 PENDING 을 건드리지 않는다 (멱등 + 오타겟 방지)', async () => {
        await seedWithOutbox([
            { id: 'A', queue: 'q', message: { n: 1 }, status: 'SENT', attempts: 1, lastAttemptAt: new Date() },
            { id: 'B', queue: 'q', message: { n: 2 }, status: 'PENDING', attempts: 0, lastAttemptAt: null },
        ]);

        await repo.markOutboxSent('s-out', 'A', new Date()); // 이미 SENT — no-op 이어야 한다

        const saga = await repo.findBySagaId('s-out');
        expect(saga.outbox.find((e) => e.id === 'B').status).toBe('PENDING'); // B 가 잘못 SENT 되면 안 됨
    });

    test('incOutboxAttempt 는 해당 엔트리의 attempts 만 증가시킨다', async () => {
        await seedWithOutbox([
            { id: 'A', queue: 'q', message: { n: 1 }, status: 'PENDING', attempts: 0, lastAttemptAt: null },
            { id: 'B', queue: 'q', message: { n: 2 }, status: 'PENDING', attempts: 0, lastAttemptAt: null },
        ]);

        await repo.incOutboxAttempt('s-out', 'B', new Date());

        const saga = await repo.findBySagaId('s-out');
        expect(saga.outbox.find((e) => e.id === 'B').attempts).toBe(1);
        expect(saga.outbox.find((e) => e.id === 'A').attempts).toBe(0);
    });
});

describe('MongoSagaRepository — deadline 필드 라운드트립 (Phase 4b)', () => {
    const repo = new MongoSagaRepository();

    beforeAll(mem.connect);
    afterEach(mem.clear);
    afterAll(mem.close);

    test('top-level deadline 을 저장하고 그대로 읽어온다', async () => {
        const deadline = new Date('2026-06-17T00:00:00.000Z');
        await repo.save({ sagaId: 'd1', orderId: 'o', state: 'STARTED', steps: [], outbox: [], deadline });

        const saga = await repo.findBySagaId('d1');
        expect(saga.deadline).toEqual(deadline);
    });
});
