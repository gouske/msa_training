/**
 * MongoSagaRepository — Saga 상태 영속화 + 원자적 전이(CAS) + 내장 outbox
 *
 * 학습 포인트(25장 Phase 4 핵심):
 *   - compareAndAdvance 는 {sagaId, state: from} 조건의 단일-도큐먼트 findOneAndUpdate 다.
 *     전이에 성공한(non-null) 처리자만 부수효과를 수행 → 동시 consumer 가 같은 reply 를 읽어도
 *     보상이 중복 실행되지 않는다(L3). 상태 전이와 "발행할 command"(outbox)를 한 번에 원자 커밋해
 *     상태만 진행되고 메시지가 유실되는 dual-write 정지(L1/L2)를 막는다(설계 §17.2 ADR-01).
 */
const { randomUUID } = require('crypto');
const SagaModel = require('../../../models/Saga');

class MongoSagaRepository {
    /**
     * sagaId 기준으로 saga 를 upsert 한다. 신규 생성과 갱신을 모두 처리한다(초기 STARTED 저장용).
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

    /**
     * 원자적 상태 전이(CAS) + step 갱신 + outbox 적재.
     * 현재 state 가 from 과 같을 때만 전이하고 갱신된 문서를 반환한다. 다르면 null(전이 실패).
     * @param {string} sagaId
     * @param {object} opts
     * @param {string} opts.from 기대 현재 상태(CAS 가드)
     * @param {string} opts.to 전이할 다음 상태
     * @param {string} [opts.currentStep] 갱신할 currentStep
     * @param {Array<{name:string,status:string,replyData?:object,deadline?:Date}>} [opts.steps] 갱신할 단계들
     * @param {Array<{queue:string,message:object}>} [opts.outbox] 적재할 발행 command 들
     * @returns {Promise<object|null>} 갱신된 saga(평범한 객체) 또는 null
     */
    async compareAndAdvance(sagaId, { from, to, currentStep, steps = [], outbox = [] }) {
        // [Phase 4b] 모든 전이는 deadline 을 비운다 — 다음 command 가 실제 SENT 될 때 릴레이가 다시 무장한다.
        // (전이 직후~발행 전 구간에 옛 deadline 이 남아 거짓 타임아웃 보상되는 것을 막는다. 설계 §17.12.1)
        const set = { state: to, deadline: null };
        if (currentStep) set.currentStep = currentStep;

        // 각 step 을 arrayFilters 로 정확히 지목해 갱신한다.
        const arrayFilters = [];
        steps.forEach((s, i) => {
            const tag = `s${i}`;
            set[`steps.$[${tag}].status`] = s.status;
            if (s.replyData) set[`steps.$[${tag}].replyData`] = s.replyData;
            if (s.deadline) set[`steps.$[${tag}].deadline`] = s.deadline;
            arrayFilters.push({ [`${tag}.name`]: s.name });
        });

        const update = { $set: set };
        if (outbox.length > 0) {
            update.$push = {
                outbox: {
                    $each: outbox.map((o) => ({
                        id: randomUUID(),
                        queue: o.queue,
                        message: o.message,
                        status: 'PENDING',
                        attempts: 0,
                        lastAttemptAt: null,
                    })),
                },
            };
        }

        const options = { returnDocument: 'after' };
        if (arrayFilters.length > 0) options.arrayFilters = arrayFilters;

        return SagaModel.findOneAndUpdate({ sagaId, state: from }, update, options).lean();
    }

    /**
     * PENDING outbox 엔트리를 가진 saga 들을 조회한다(릴레이 워커용).
     * @param {number} limit 최대 조회 개수
     * @returns {Promise<Array<object>>}
     */
    async findWithPendingOutbox(limit = 20) {
        return SagaModel.find({ 'outbox.status': 'PENDING' }).limit(limit).lean();
    }

    /**
     * outbox 엔트리를 SENT 로 표시한다(PENDING 일 때만 — 동시 릴레이에서 한 번만 성공).
     * deadline 을 주면 같은 원자 update 로 top-level deadline 도 무장한다([Phase 4b] reply 대기 타이머 시작).
     *
     * 주의: id 와 status 조건을 같은 배열의 "단일 요소"에 묶어야 한다. $elemMatch 로 한 요소에 두 조건을
     *   묶으면 positional `$` 가 그 요소를 정확히 지목하고, deadline 무장도 SENT 승자에게만 일어난다
     *   (이미 SENT 인 엔트리엔 top-level 필터가 매칭 안 돼 update 전체가 no-op).
     * @param {string} sagaId
     * @param {string} entryId outbox 엔트리 id
     * @param {Date} now 발행 시도 시각
     * @param {Date} [deadline] 무장할 reply 대기 마감 시각(없으면 deadline 변경 안 함)
     */
    async markOutboxSent(sagaId, entryId, now, deadline) {
        const set = { 'outbox.$.status': 'SENT', 'outbox.$.lastAttemptAt': now };
        if (deadline) set.deadline = deadline;
        await SagaModel.updateOne(
            { sagaId, outbox: { $elemMatch: { id: entryId, status: 'PENDING' } } },
            { $set: set },
        );
    }

    /**
     * outbox 엔트리의 발행 시도 횟수를 증가시킨다(발행 실패 시).
     * @param {string} sagaId
     * @param {string} entryId outbox 엔트리 id
     * @param {Date} now 발행 시도 시각
     */
    async incOutboxAttempt(sagaId, entryId, now) {
        await SagaModel.updateOne(
            { sagaId, 'outbox.id': entryId },
            { $inc: { 'outbox.$.attempts': 1 }, $set: { 'outbox.$.lastAttemptAt': now } },
        );
    }
}

module.exports = MongoSagaRepository;
