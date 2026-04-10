/**
 * MongoOrderRepository — MongoDB 저장소 구현체
 *
 * 학습 포인트:
 *   - Repository 패턴: DB 접근 로직을 도메인 서비스로부터 분리합니다
 *   - 도메인 Order 객체를 받아 MongoDB 문서로 변환하여 저장합니다
 *   - updateStatus()는 {_id, status: 'PENDING'} 조건으로 원자적 업데이트를 수행합니다
 *     → PENDING인 주문만 업데이트, 이미 종결된 경우 null 반환
 */
const OrderModel = require('../../models/Order');

class MongoOrderRepository {
    /**
     * 도메인 Order를 MongoDB에 저장하고 생성된 ID를 반환합니다
     * @param {Order} domainOrder
     * @returns {Promise<string>} orderId
     */
    async save(domainOrder) {
        const mongoOrder = new OrderModel({
            userEmail: domainOrder.userEmail,
            itemId:    domainOrder.item.productId,
            quantity:  domainOrder.item.quantity,
            price:     domainOrder.item.unitPrice.amount,
            status:    domainOrder.status,
        });
        const saved = await mongoOrder.save();
        return saved._id.toString();
    }

    /**
     * ID로 주문 문서를 조회합니다 (없으면 null)
     * @param {string} orderId
     * @returns {Promise<object|null>}
     */
    async findById(orderId) {
        return OrderModel.findById(orderId);
    }

    /**
     * PENDING 상태인 주문의 status를 원자적으로 업데이트합니다
     * PENDING이 아닌 경우 null을 반환합니다 (멱등성 보장)
     * @param {string} orderId
     * @param {string} newStatus - 'SUCCESS' | 'FAILED'
     * @returns {Promise<object|null>} 업데이트된 문서 또는 null
     */
    async updateStatus(orderId, newStatus) {
        return OrderModel.findOneAndUpdate(
            { _id: orderId, status: 'PENDING' }, // 조건: PENDING 상태인 주문만
            { status: newStatus },                // 변경
            { new: true }                         // 수정된 문서 반환
        );
    }
}

module.exports = MongoOrderRepository;
