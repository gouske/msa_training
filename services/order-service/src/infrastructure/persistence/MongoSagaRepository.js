/**
 * MongoSagaRepository — Saga 상태 영속화
 *
 * 학습 포인트:
 *   - Saga 상태를 DB 에 영속화하면, 서비스가 재시작되어도 진행 중이던 Saga 를 복구할 수 있습니다.
 *   - save() 는 sagaId 기준 upsert — 신규 생성과 갱신을 모두 처리합니다.
 */
const SagaModel = require('../../../models/Saga');

class MongoSagaRepository {
    /**
     * sagaId 기준으로 saga 를 upsert 한다.
     * @param {object} saga - Orchestrator 가 다루는 평범한 객체
     * @returns {Promise<object>} 저장한 saga
     */
    async save(saga) {
        await SagaModel.updateOne(
            { sagaId: saga.sagaId },
            { $set: saga },
            { upsert: true },
        );
        return saga;
    }

    /**
     * sagaId 로 saga 를 조회한다(없으면 null). lean() 으로 평범한 객체를 반환한다.
     * @param {string} sagaId
     * @returns {Promise<object|null>}
     */
    async findBySagaId(sagaId) {
        return SagaModel.findOne({ sagaId }).lean();
    }
}

module.exports = MongoSagaRepository;
