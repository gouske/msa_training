/**
 * [Infrastructure] [제24강] Prometheus 메트릭 수집 모듈
 *
 * RED 메트릭 (Rate, Errors, Duration) 을 자동 수집한다:
 *   - http_requests_total       : 카운터 (요청 수, 에러율 계산 가능)
 *   - http_request_duration_seconds : 히스토그램 (응답 시간 분포 → p50/p95/p99 계산 가능)
 *
 * 설계 원칙:
 *   1. 라우트 라벨은 매칭된 패턴(/api/order/:id)으로 정규화 — 카디널리티 폭발 방지.
 *      raw URL(/api/order/abc123)을 그대로 라벨에 넣으면 시계열 수가 무한히 커진다.
 *   2. /metrics 엔드포인트 자체는 메트릭 대상에서 제외 — 관측 부트스트랩 루프 방지.
 *   3. createMetrics() 가 의존성 주입 형태로 registry 를 받음 — 테스트 격리 가능.
 *      운영 코드는 prom-client 의 전역 register 를 그대로 사용한다.
 */

const client = require('prom-client');

/**
 * 메트릭 인스턴스 + 미들웨어 + 핸들러 묶음을 생성한다.
 *
 * @param {object} [options]
 * @param {client.Registry} [options.registry] - Prometheus 메트릭 레지스트리
 *   (테스트에서 격리하려면 새 Registry 를 주입, 운영은 client.register 사용)
 * @param {string} [options.serviceName='order-service'] - 기본 메트릭 prefix
 * @param {string} [options.metricsPath='/api/order/metrics'] - 메트릭 엔드포인트 경로
 *   (자기 자신을 카운트하지 않도록 미들웨어에서 제외 처리)
 * @returns {{ middleware: Function, handler: Function, registry: client.Registry }}
 */
function createMetrics(options = {}) {
    const {
        registry = client.register,
        serviceName = 'order-service',
        metricsPath = '/api/order/metrics',
    } = options;

    // Node.js 기본 메트릭 (CPU, 메모리, 이벤트 루프 지연 등) — 운영 가시성에 유용
    client.collectDefaultMetrics({ register: registry, prefix: `${serviceName.replace(/-/g, '_')}_` });

    /**
     * RED 의 Rate + Errors 계산용 카운터.
     * 라벨 조합 = (method, route, status_code).
     *   - 에러율 = sum(rate(http_requests_total{status_code=~"5.."}[5m]))
     *           / sum(rate(http_requests_total[5m]))
     */
    const httpRequestsTotal = new client.Counter({
        name: 'http_requests_total',
        help: 'HTTP 요청 총 수 (카디널리티 안전: route 는 Express 매칭 패턴으로 정규화)',
        labelNames: ['method', 'route', 'status_code'],
        registers: [registry],
    });

    /**
     * RED 의 Duration 계산용 히스토그램.
     * buckets 는 5ms~10s — 일반 HTTP API 의 p95~p99 분포를 잘 표현하는 범위.
     *   - p95 = histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))
     */
    const httpRequestDuration = new client.Histogram({
        name: 'http_request_duration_seconds',
        help: 'HTTP 요청 처리 시간 (초)',
        labelNames: ['method', 'route'],
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
        registers: [registry],
    });

    /**
     * [Codex finding #2 반영] 외부 의존성(예: MongoDB) 의 연결 가용성 gauge.
     *
     * 왜 별도 메트릭이 필요한가:
     *   Prometheus 의 `up` 메트릭은 scrape 성공 여부만 의미한다 — /metrics 가 200 이면 1.
     *   그러나 우리 서비스는 Mongo 가 끊겨도 /metrics 자체는 정상 응답하므로 up=1 인 상태에서
     *   주문 요청은 503 으로 실패할 수 있다 (= 거짓 양성).
     *   별도 gauge 로 의존성 상태를 분리하면 대시보드/알림이 진짜 health 를 표현할 수 있다.
     *
     * 라벨 dependency 의 카디널리티는 의도적으로 낮게 유지 (mongodb / rabbitmq / consul 정도).
     * 동적 값 (예: 호스트명) 을 라벨에 넣지 말 것.
     */
    const serviceDependencyReady = new client.Gauge({
        name: 'service_dependency_ready',
        help: '외부 의존성 연결 가용성 (1=ready, 0=not ready)',
        labelNames: ['dependency'],
        registers: [registry],
    });

    /**
     * Express 라우터 매칭이 끝난 시점의 라벨용 라우트 키를 계산한다.
     * 우선순위:
     *   1. req.route.path - 라우터 매칭이 성공한 경우 (/api/order/:id)
     *   2. req.baseUrl + req.route.path - 라우터 모듈을 use() 로 마운트한 경우
     *   3. 'unmatched' - 라우터 매칭 실패 (404 등) — raw URL 노출 회피
     */
    function resolveRouteLabel(req) {
        if (req.route && req.route.path) {
            return (req.baseUrl || '') + req.route.path;
        }
        return 'unmatched';
    }

    /**
     * Express 미들웨어 — 모든 요청의 RED 메트릭을 자동 수집한다.
     * /metrics 엔드포인트 자체는 카운터 / 히스토그램 모두에서 제외한다.
     *
     * [Codex finding #3 반영] finish 와 close 둘 다 처리.
     *   Node 의 응답 종료 이벤트는 시나리오마다 다르다:
     *     - 정상 응답: finish → close 가 따라옴
     *     - 클라이언트 중단 / upstream timeout / socket reset: close 만 발생, finish 없음
     *   finish 만 listen 하면 비정상 종료 케이스가 그래프에서 사라져 장애 시 실패율을 과소계상한다.
     *
     *   once-guard (recorded 플래그) 로 같은 요청의 finish→close 가 이중 카운트되지 않게 한다.
     *   응답이 정상 send 되지 않은 경우 status_code 라벨은 '0' 으로 분리해 운영자가 식별할 수 있게 한다.
     */
    function middleware(req, res, next) {
        // 메트릭 엔드포인트 자체는 측정 대상이 아니다.
        // (Prometheus scrape 가 들어올 때마다 자기 자신 카운트가 늘어나면 노이즈)
        if (req.path === metricsPath) {
            return next();
        }

        // 응답 본문이 쓰이기 전에 시작 시점을 기록.
        // 라벨 결정은 응답 종료 시점 — 그래야 req.route 가 채워진 상태가 된다.
        const startNs = process.hrtime.bigint();
        let recorded = false;

        function recordOutcome() {
            if (recorded) return;
            recorded = true;

            const route = resolveRouteLabel(req);
            const method = req.method;
            // res.writableEnded === true 면 응답이 정상적으로 send 됨 → 실제 statusCode 사용.
            // false (혹은 falsy) 면 클라이언트 중단/timeout 으로 응답이 끝까지 안 나감 → '0' 라벨링.
            const statusCode = res.writableEnded ? String(res.statusCode) : '0';

            httpRequestsTotal.inc({ method, route, status_code: statusCode });

            const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9;
            httpRequestDuration.observe({ method, route }, durationSec);
        }

        res.on('finish', recordOutcome);
        res.on('close', recordOutcome);

        next();
    }

    /**
     * /metrics 엔드포인트 핸들러.
     * Prometheus 가 주기적으로(scrape_interval=15s) GET /metrics 를 호출한다.
     */
    async function handler(req, res) {
        try {
            res.set('Content-Type', registry.contentType);
            res.end(await registry.metrics());
        } catch (err) {
            res.status(500).end(`# metrics rendering failed: ${err.message}`);
        }
    }

    /**
     * [Codex finding #2 반영] 의존성 상태 업데이트 API.
     * 호출 예: dependencies.setReady('mongodb', true) — Mongo 연결 시
     *         dependencies.setReady('mongodb', false) — Mongo 단절 시
     */
    const dependencies = {
        setReady(name, ready) {
            serviceDependencyReady.set({ dependency: name }, ready ? 1 : 0);
        },
    };

    return { middleware, handler, registry, dependencies };
}

module.exports = { createMetrics };
