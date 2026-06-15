/**
 * mongodb-memory-server 기반 테스트 헬퍼.
 * standalone mongod 를 띄운다 — 운영(order-db)과 동일 구성이라 단일 도큐먼트 원자성/CAS 검증에 적합.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;

/** 테스트 시작 전: 메모리 mongod 기동 + mongoose 연결 */
async function connect() {
    mongod = await MongoMemoryServer.create();
    try {
        await mongoose.connect(mongod.getUri());
    } catch (err) {
        // 연결 실패 시 띄운 mongod 를 정리해 프로세스 고아를 막는다.
        await mongod.stop();
        mongod = undefined;
        throw err;
    }
}

/** 각 테스트 후: 모든 컬렉션 비우기(테스트 격리) */
async function clear() {
    const { collections } = mongoose.connection;
    for (const key of Object.keys(collections)) {
        await collections[key].deleteMany({});
    }
}

/** 테스트 종료 후: 연결 해제 + mongod 정지 */
async function close() {
    await mongoose.disconnect();
    if (mongod) await mongod.stop();
}

module.exports = { connect, clear, close };
