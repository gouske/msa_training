const config = require('../../src/saga/sagaConfig');

describe('sagaConfig — Phase 4b 튜닝 상수', () => {
    test('4b 상수가 기본값과 함께 노출된다', () => {
        expect(config.STEP_TIMEOUT_MS).toBe(15000);
        expect(config.TIMEOUT_SWEEP_INTERVAL_MS).toBe(5000);
        expect(config.MAX_COMPENSATE_ATTEMPTS).toBe(5);
        expect(config.MAX_OUTBOX_ATTEMPTS).toBe(10);
    });

    test('기존 4a 상수도 유지된다', () => {
        expect(config.OUTBOX_RELAY_INTERVAL_MS).toBe(2000);
    });
});
