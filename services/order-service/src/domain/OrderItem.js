/**
 * OrderItem 값 객체 (Value Object)
 *
 * 학습 포인트:
 *   - "상품 ID + 단가(Money) + 수량"을 하나의 단위로 묶습니다
 *   - Order 내에서만 존재하며, Order Aggregate를 통해서만 접근됩니다
 */
const Money = require('./Money');

class OrderItem {
    constructor(productId, unitPrice, quantity) {
        if (!productId) {
            throw new Error('상품 ID는 필수입니다');
        }
        if (quantity <= 0) {
            throw new Error(`수량은 양수여야 합니다: ${quantity}`);
        }
        this._productId = productId;
        this._unitPrice = unitPrice;
        this._quantity = quantity;
        Object.freeze(this);
    }

    get productId() { return this._productId; }
    get unitPrice() { return this._unitPrice; }
    get quantity() { return this._quantity; }

    /** 단가 × 수량을 Money로 반환합니다 */
    totalPrice() {
        return this._unitPrice.multipliedBy(this._quantity);
    }
}

module.exports = OrderItem;
