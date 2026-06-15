const mem = require('../helpers/mongoMemory');
const InventoryModel = require('../../models/Inventory');
const MongoInventoryRepository = require('../../src/infrastructure/persistence/MongoInventoryRepository');

describe('MongoInventoryRepository — 멱등키 reserve/release', () => {
    const repo = new MongoInventoryRepository();

    beforeAll(mem.connect);
    afterEach(mem.clear);
    afterAll(mem.close);

    beforeEach(async () => {
        await InventoryModel.create({ itemId: 'ITEM-1', available: 10 });
    });

    test('재고가 충분하면 차감하고 true 를 반환하며 reservedSagas 에 sagaId 를 남긴다', async () => {
        const ok = await repo.reserve('ITEM-1', 3, 'saga-1');

        expect(ok).toBe(true);
        const inv = await InventoryModel.findOne({ itemId: 'ITEM-1' }).lean();
        expect(inv.available).toBe(7);
        expect(inv.reservedSagas).toEqual(['saga-1']);
    });

    test('같은 sagaId 로 reserve 를 다시 호출해도 추가 차감 없이 true (멱등)', async () => {
        await repo.reserve('ITEM-1', 3, 'saga-1');
        const second = await repo.reserve('ITEM-1', 3, 'saga-1');

        expect(second).toBe(true);
        const inv = await InventoryModel.findOne({ itemId: 'ITEM-1' }).lean();
        expect(inv.available).toBe(7); // 한 번만 차감
        expect(inv.reservedSagas).toEqual(['saga-1']);
    });

    test('재고가 부족하면 false 를 반환하고 차감하지 않는다', async () => {
        const ok = await repo.reserve('ITEM-1', 99, 'saga-1');

        expect(ok).toBe(false);
        const inv = await InventoryModel.findOne({ itemId: 'ITEM-1' }).lean();
        expect(inv.available).toBe(10);
    });

    test('release 는 수량을 복원하고 releasedSagas 에 sagaId 를 남긴다', async () => {
        await repo.reserve('ITEM-1', 3, 'saga-1');

        await repo.release('ITEM-1', 3, 'saga-1');

        const inv = await InventoryModel.findOne({ itemId: 'ITEM-1' }).lean();
        expect(inv.available).toBe(10);
        expect(inv.releasedSagas).toEqual(['saga-1']);
    });

    test('같은 sagaId 로 release 를 다시 호출해도 추가 복원하지 않는다 (멱등 — L3 회귀)', async () => {
        await repo.reserve('ITEM-1', 3, 'saga-1');

        await repo.release('ITEM-1', 3, 'saga-1');
        await repo.release('ITEM-1', 3, 'saga-1'); // 중복 보상

        const inv = await InventoryModel.findOne({ itemId: 'ITEM-1' }).lean();
        expect(inv.available).toBe(10); // 부풀려지지 않음(7→10 한 번만)
        expect(inv.releasedSagas).toEqual(['saga-1']);
    });
});
