/**
 * [메시징 모듈] RabbitMQ 메시지 발행자 (Producer)
 *
 * 역할: 주문 생성 시 결제 요청 메시지를 RabbitMQ 큐에 발행합니다.
 * [비동기 패턴 핵심 장점] 동기식 HTTP 호출 대신 메시지 큐를 사용하면:
 * - Order Service는 결제 완료를 기다리지 않고 즉시 응답 가능
 * - Payment Service가 다운되어도 메시지가 큐에 안전하게 보존됨 (durable: true)
 */

// amqplib: Node.js에서 AMQP 0-9-1 프로토콜(RabbitMQ 기본 프로토콜)을 사용하는 라이브러리
const amqp = require('amqplib');

// 환경 변수로 RabbitMQ 주소를 받습니다.
// Docker 환경: 'amqp://rabbitmq' (docker-compose 서비스 이름)
// 로컬 실행: 'amqp://localhost'
const rabbitmqUrl = process.env.RABBITMQ_URL || 'amqp://localhost';

/**
 * 주문 메시지를 RabbitMQ order_queue에 발행합니다.
 * @param {Object} orderData - { orderId: string, amount: number, userEmail: string }
 */
async function sendOrderMessage(orderData) {
    // 1. RabbitMQ 서버(우체국)에 TCP 연결 후 AMQP 핸드셰이크 수행
    const connection = await amqp.connect(rabbitmqUrl);

    // 2. 채널 생성 - 하나의 TCP 연결 위에서 동작하는 가상의 논리적 통신 경로
    //    실제 메시지 송수신은 connection이 아닌 channel을 통해 이루어집니다.
    const channel = await connection.createChannel();

    // [제21강 추가] DLQ(Dead Letter Queue) 선언
    // 처리에 실패한 메시지가 이동하는 "실패 보관함"입니다.
    // Consumer(payment-service)의 큐 선언과 동일하게 맞춰야 합니다.
    await channel.assertQueue('order_dlq', { durable: true });

    // 3. 큐(우체통) 선언
    //    assertQueue: 큐가 없으면 생성, 있으면 기존 큐를 그대로 사용합니다.
    //    durable: true → RabbitMQ가 재시작되어도 큐 정의가 유지됩니다. (메시지 유실 방지)
    //
    // [제21강 변경] DLQ 연결 arguments 추가
    // 이전: await channel.assertQueue(queue, { durable: true });
    // 이후: arguments로 NACK된 메시지가 order_dlq로 이동하도록 설정
    //
    // 주의: 기존에 arguments 없이 선언된 order_queue가 이미 있으면
    //       RabbitMQ가 속성 충돌 오류를 발생시킵니다.
    //       이 경우 docker-compose down -v로 볼륨을 삭제하고 재시작하세요.
    const queue = 'order_queue';
    await channel.assertQueue(queue, {
        durable: true,
        arguments: {
            'x-dead-letter-exchange': '',            // 기본 exchange 사용
            'x-dead-letter-routing-key': 'order_dlq' // 실패 메시지 → order_dlq
        }
    });

    // 4. 메시지 발행
    //    JSON 객체 → 문자열 직렬화 → Buffer(이진 데이터)로 변환하여 큐에 넣습니다.
    //    Buffer.from(): RabbitMQ는 바이트 배열로 메시지를 전송하기 때문에 변환이 필요합니다.
    channel.sendToQueue(queue, Buffer.from(JSON.stringify(orderData)));
    console.log(" [x] 주문 메시지 발행 완료:", orderData);

    // 5. 채널 → 연결 순서로 명시적으로 닫기
    //    [수정] 기존 setTimeout(..., 500) 방식은 전송 완료 전에 연결이 끊길 수 있었습니다.
    //    await로 순서를 보장하여 메시지가 전달된 이후에 연결을 닫습니다.
    await channel.close();
    await connection.close();
}

// 이 모듈을 require()로 불러갈 수 있도록 함수를 내보냅니다.
module.exports = { sendOrderMessage };
