/**
 * Order Service — 최소 부트스트랩
 *
 * [제18강 변경사항 — DDD 리팩터링]
 *   이전: index.js에 라우트 핸들러 로직 직접 작성
 *   이후: 의존성만 조립하고 라우터를 등록하는 부트스트랩 역할만 담당
 *
 * 의존성 조립(Composition Root):
 *   MongoOrderRepository → OrderService → createOrderRouter 순서로 조립합니다.
 *   각 계층은 인터페이스(메서드 시그니처)만 알고 구현체를 직접 참조하지 않습니다.
 */

const express = require('express');
const mongoose = require('mongoose');

// [비동기 메시징] RabbitMQ 메시지 발행 모듈
const { sendOrderMessage } = require('./producer');

// [실전 #6] Consul 자기 등록 모듈
const { register, setupGracefulShutdown } = require('./infrastructure/consulRegistrar');

// [DDD 계층] 인프라 → 애플리케이션 → 인터페이스 순서로 의존성 조립
const MongoOrderRepository = require('./src/infrastructure/persistence/MongoOrderRepository');
const { OrderService } = require('./src/application/OrderService');
const { createOrderRouter } = require('./src/interfaces/routes/orderRoutes');

// [제24강] Prometheus 메트릭 — RED (Rate, Errors, Duration) 자동 수집
const { createMetrics } = require('./src/infrastructure/metrics');

// [제25강 Saga Phase 2] Saga 오케스트레이션 의존성
const MongoInventoryRepository = require('./src/infrastructure/persistence/MongoInventoryRepository');
const MongoSagaRepository = require('./src/infrastructure/persistence/MongoSagaRepository');
const { SagaOrchestrator } = require('./src/saga/SagaOrchestrator');
const { RabbitMQConnection } = require('./src/infrastructure/messaging/RabbitMQConnection');
const { SagaCommandPublisher } = require('./src/infrastructure/messaging/SagaCommandPublisher');
const { SagaReplyConsumer } = require('./src/infrastructure/messaging/SagaReplyConsumer');

const PORT = 8081;

const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/order_db';

// [핫픽스] 기본값 fallback 제거 — 환경변수 미설정 시 즉시 에러로 누락을 방지합니다.
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
if (!INTERNAL_API_KEY) {
    console.error("🚨 INTERNAL_API_KEY 환경변수가 설정되지 않았습니다. .env 파일을 확인하세요.");
    process.exit(1);
}

// -----------------------------------------------------------
// 의존성 조립 (Composition Root)
// -----------------------------------------------------------

// 1. 인프라 계층: MongoDB 저장소
const orderRepository = new MongoOrderRepository();

// 2. producer.js 함수를 도메인이 기대하는 { publish } 인터페이스로 래핑
//    → OrderService는 RabbitMQ를 모르고, publish() 메서드만 알고 있습니다.
const messagePublisher = { publish: sendOrderMessage };

// 3. 애플리케이션 서비스: 저장소 + 메시지 발행자 주입
const orderService = new OrderService(orderRepository, messagePublisher);

// 4-a. [제25강 Saga] Saga 오케스트레이션 조립
//      재고/Saga 저장소 + 상주 RabbitMQ 연결 + command publisher + reply consumer
const inventoryRepository = new MongoInventoryRepository();
const sagaRepository = new MongoSagaRepository();
const rabbit = new RabbitMQConnection();
const commandPublisher = new SagaCommandPublisher(() => rabbit.getChannel());
const sagaOrchestrator = new SagaOrchestrator({
    orderRepository,
    inventoryRepository,
    sagaRepository,
    commandPublisher,
});
const sagaReplyConsumer = new SagaReplyConsumer({
    channelProvider: () => rabbit.getChannel(),
    orchestrator: sagaOrchestrator,
});

// 4-b. 라우터: 서비스 + orchestrator(Saga) + 내부 키 주입
const orderRouter = createOrderRouter({
    orderService,
    orchestrator: sagaOrchestrator,
    internalApiKey: INTERNAL_API_KEY,
});

// -----------------------------------------------------------
// Express 앱 구성
// -----------------------------------------------------------
const app = express();
app.use(express.json());

// [제24강] 메트릭 미들웨어 — 모든 라우터보다 먼저 등록해야 res.on('finish'/'close') 가 항상 잡힌다.
// metricsPath 의 self-scrape 는 미들웨어 내부에서 자동 제외되므로 카디널리티 안전.
const metrics = createMetrics({ serviceName: 'order-service', metricsPath: '/api/order/metrics' });
app.use(metrics.middleware);

// /api/order/metrics 는 라우터(/api/order)보다 먼저 등록한다.
// 그렇지 않으면 라우터의 와일드카드(/api/order/:id 등)가 'metrics' 를 잡아갈 수 있다.
app.get('/api/order/metrics', metrics.handler);

app.use('/api/order', orderRouter);

// [Codex finding #2 반영] MongoDB 연결 상태를 service_dependency_ready{dependency="mongodb"} 로 노출.
// Prometheus `up` 메트릭은 /metrics scrape 성공 여부만 본다 — Mongo 가 끊겨도 up=1 이므로
// 별도 신호가 있어야 운영 대시보드가 진짜 health 를 보여줄 수 있다.
mongoose.connection.on('connected',    () => metrics.dependencies.setReady('mongodb', true));
mongoose.connection.on('disconnected', () => metrics.dependencies.setReady('mongodb', false));
mongoose.connection.on('error',        () => metrics.dependencies.setReady('mongodb', false));
// 초기값을 false 로 명시 — 시계열이 적어도 한 번은 export 되어야 Grafana 가 패널을 표시한다.
metrics.dependencies.setReady('mongodb', false);

// -----------------------------------------------------------
// DB 연결 + 서버 시작
// -----------------------------------------------------------
// [Issue #13] fail-fast — MongoDB 연결 실패 시 프로세스 종료.
//
// 이전: .catch(err => console.log(err)) 만 호출하여 연결 실패에도 Express 가 떴다.
//       그 결과 K8s 는 Pod 를 Ready 로 보고, 모든 주문 요청이 500 으로 실패했다.
// 현재: mongoose.connect() 가 실패하면 process.exit(1) 으로 즉시 종료한다.
//       K8s 는 CrashLoopBackOff 로 인지하여 재시작 간격을 자동으로 늘리고,
//       장애 가시성이 명확해진다.
mongoose.connect(mongoURI)
    .then(() => {
        console.log('MongoDB Connected...');
        startHttpServer();
    })
    .catch((err) => {
        console.error('🚨 MongoDB 연결 실패. 프로세스를 종료합니다.', err);
        process.exit(1);
    });

function startHttpServer() {
    app.listen(PORT, () => {
        console.log(`🚀 주문 서비스가 http://localhost:${PORT} 에서 시작되었습니다.`);

        // [제25강 Saga Phase 2] saga.reply 구독 시작 — participant들의 응답을 수신해 상태머신을 전이.
        // RabbitMQ 미준비 시 실패할 수 있으므로 에러는 경고만 남기고 서버 자체는 계속 뜬다
        // (consumer는 RabbitMQConnection이 다음 getChannel 호출 때 재연결을 시도한다).
        sagaReplyConsumer.start().catch((err) => {
            console.warn('⚠️ saga.reply consumer 시작 실패(재시도 대상):', err.message);
        });

        // [실전 #6 + K8s 회고] Consul 자기 등록.
        //
        // 주소 우선순위:
        //   1. POD_IP                  (K8s Downward API — Pod 별 유니크 IP)
        //   2. CONSUL_SERVICE_ADDRESS  (Docker Compose 의 hostname)
        //   3. HOSTNAME                (컨테이너/로컬 호스트네임)
        //   4. 'order-service'         (최후 fallback)
        //
        // 인스턴스 키 우선순위 (serviceId 충돌 차단):
        //   1. POD_NAME (K8s — replica 마다 유니크)
        //   2. host     (Docker Compose 호환)
        const consulUrl = `http://${process.env.CONSUL_HOST || 'localhost'}:${process.env.CONSUL_PORT || 8500}`;
        const myHost = process.env.POD_IP
            || process.env.CONSUL_SERVICE_ADDRESS
            || process.env.HOSTNAME
            || 'order-service';
        const myInstanceKey = process.env.POD_NAME || myHost;
        register({
            consulUrl,
            name: 'order-service',
            host: myHost,
            port: PORT,
            healthPath: '/api/order/health',
            instanceKey: myInstanceKey,
        }).then((serviceId) => {
            setupGracefulShutdown(consulUrl, serviceId);
        }).catch((err) => {
            console.warn('Consul 등록 실패 (무시):', err.message);
        });
    });
}
