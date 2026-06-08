const mongoose = require('mongoose');

// 재고: itemId 당 가용 수량. available 은 0 미만이 될 수 없다(스키마 레벨 가드).
const InventorySchema = new mongoose.Schema({
    itemId:    { type: String, required: true, unique: true },
    available: { type: Number, required: true, min: 0 },
});

module.exports = mongoose.model('Inventory', InventorySchema);
