/**
 * MongoInventoryRepository — 재고 원자적 예약/복원
 *
 * 학습 포인트(25장 핵심):
 *   - reserve() 는 "available 이 충분할 때만 차감"을 단 한 번의 원자적 연산으로 처리합니다.
 *   - findOneAndUpdate 의 조건 {available: {$gte: qty}} 가 동시 주문 간 과잉 판매(oversell)를
 *     막아 줍니다. 도메인 객체를 읽어 와 차감 후 저장하는 방식은 race condition 에 취약합니다.
 */
const InventoryModel = require('../../../models/Inventory');

class MongoInventoryRepository {
    /**
     * 재고가 충분하면 차감하고 true, 부족하면 false 를 반환한다.
     * @param {string} itemId
     * @param {number} quantity
     * @returns {Promise<boolean>}
     */
    async reserve(itemId, quantity) {
        const updated = await InventoryModel.findOneAndUpdate(
            { itemId, available: { $gte: quantity } }, // 충분할 때만 매칭
            { $inc: { available: -quantity } },
            { new: true },
        );
        return updated !== null;
    }

    /**
     * 예약했던 수량을 되돌린다(보상).
     * @param {string} itemId
     * @param {number} quantity
     */
    async release(itemId, quantity) {
        await InventoryModel.updateOne(
            { itemId },
            { $inc: { available: quantity } },
        );
    }
}

module.exports = MongoInventoryRepository;
