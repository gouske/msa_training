/**
 * MongoInventoryRepository — 재고 원자적·멱등 예약/복원
 *
 * 학습 포인트(25장 핵심):
 *   - reserve/release 를 sagaId 멱등키로 만든다. 같은 saga 의 명령이 중복돼도(at-least-once,
 *     복구 워커 재구동) 단 한 번만 반영된다 → 보상 중복으로 재고가 부풀려지는 L3 결함을 막는다.
 *   - 조건부 단일 연산(findOneAndUpdate)이라 동시 주문 간 과잉 판매(oversell)도 함께 막는다.
 */
const InventoryModel = require('../../../models/Inventory');

class MongoInventoryRepository {
    /**
     * 재고가 충분하면 차감하고 true, 부족하면 false. 같은 sagaId 재호출은 멱등(추가 차감 없음).
     * @param {string} itemId
     * @param {number} quantity
     * @param {string} sagaId 멱등 키
     * @returns {Promise<boolean>}
     */
    async reserve(itemId, quantity, sagaId) {
        // 아직 이 saga 로 예약하지 않았고 재고가 충분할 때만 차감 + sagaId 기록(원자적).
        const updated = await InventoryModel.findOneAndUpdate(
            { itemId, available: { $gte: quantity }, reservedSagas: { $ne: sagaId } },
            { $inc: { available: -quantity }, $push: { reservedSagas: sagaId } },
            { returnDocument: 'after' },
        );
        if (updated) return true;

        // 매칭 실패 = (이미 이 saga 로 예약했거나) 또는 (재고 부족). 멱등 재호출이면 true.
        const already = await InventoryModel.exists({ itemId, reservedSagas: sagaId });
        return already !== null;
    }

    /**
     * 예약했던 수량을 되돌린다(보상). 같은 sagaId 재호출은 멱등(추가 복원 없음).
     * @param {string} itemId
     * @param {number} quantity
     * @param {string} sagaId 멱등 키
     */
    async release(itemId, quantity, sagaId) {
        await InventoryModel.findOneAndUpdate(
            { itemId, releasedSagas: { $ne: sagaId } }, // 이 saga 로 아직 안 푼 경우만
            { $inc: { available: quantity }, $push: { releasedSagas: sagaId } },
        );
    }
}

module.exports = MongoInventoryRepository;
