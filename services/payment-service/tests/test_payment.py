"""
[테스트] Payment Service 단위 테스트

학습 포인트:
  1. pytest로 FastAPI 엔드포인트를 테스트하는 방법
  2. TestClient로 실제 HTTP 서버 없이 요청을 보내는 방법
  3. unittest.mock으로 RabbitMQ, HTTP 콜백 등 외부 의존성을 격리하는 방법

실행: cd services/payment-service && python -m pytest tests/ -v
"""

import json
from unittest.mock import patch, MagicMock

import pytest
import requests  # [제21강 추가] HTTPError 예외 클래스를 사용하기 위해 import
from fastapi.testclient import TestClient

# FastAPI 앱을 import합니다.
# lifespan 이벤트에서 RabbitMQ consumer 스레드가 시작되므로
# 테스트 시에는 해당 스레드를 mock 처리합니다.
from main import app, process_payment, on_order_message, PaymentRequest


# ==========================================================
# 1. FastAPI TestClient 생성
#    실제 Uvicorn 서버를 띄우지 않고 테스트합니다.
# ==========================================================
@pytest.fixture
def client():
    """
    TestClient는 FastAPI 앱에 HTTP 요청을 보내는 테스트 전용 도구입니다.
    with 문으로 감싸면 lifespan 이벤트(startup/shutdown)도 실행됩니다.
    여기서는 RabbitMQ consumer 스레드를 mock하여 실제 연결 없이 테스트합니다.
    """
    with patch("main.start_consumer"):  # RabbitMQ consumer 스레드 비활성화
        with TestClient(app) as c:
            yield c


# ==========================================================
# 2. GET /api/payment/health — 헬스 체크 테스트
# ==========================================================
class TestHealthCheck:
    """헬스 체크 엔드포인트 테스트"""

    def test_health_check_returns_ok(self, client):
        """헬스 체크가 200 OK와 상태 메시지를 반환하는지 확인"""
        # WHEN: 헬스 체크 요청
        response = client.get("/api/payment/health")

        # THEN: 200 OK + 상태 정보
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "OK"
        assert "Payment Service" in data["message"]


# ==========================================================
# 3. POST /api/payment/process — HTTP 동기 결제 테스트
# ==========================================================
class TestProcessPaymentHTTP:
    """HTTP 동기 결제 엔드포인트 테스트"""

    def test_valid_payment_returns_completed(self, client):
        """정상 결제 요청 시 COMPLETED 상태를 반환하는지 확인"""
        # WHEN: 결제 요청
        response = client.post("/api/payment/process", json={
            "orderId": "order-123",
            "amount": 50000
        })

        # THEN: 결제 성공
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "COMPLETED"
        assert data["paymentId"] == "PAY-order-123"
        assert "50000원" in data["message"]

    def test_payment_id_format(self, client):
        """결제 ID가 'PAY-{orderId}' 형식인지 확인"""
        response = client.post("/api/payment/process", json={
            "orderId": "abc-def-789",
            "amount": 10000
        })

        data = response.json()
        assert data["paymentId"] == "PAY-abc-def-789"

    def test_missing_order_id_returns_422(self, client):
        """orderId 누락 시 Pydantic 검증 에러(422)를 반환하는지 확인"""
        # WHEN: orderId 없이 요청
        response = client.post("/api/payment/process", json={
            "amount": 10000
        })

        # THEN: 422 Unprocessable Entity (Pydantic 검증 실패)
        assert response.status_code == 422

    def test_missing_amount_returns_422(self, client):
        """amount 누락 시 Pydantic 검증 에러(422)를 반환하는지 확인"""
        response = client.post("/api/payment/process", json={
            "orderId": "order-456"
        })

        assert response.status_code == 422

    def test_invalid_amount_type_returns_422(self, client):
        """amount가 숫자가 아닌 경우 422를 반환하는지 확인"""
        response = client.post("/api/payment/process", json={
            "orderId": "order-789",
            "amount": "not-a-number"
        })

        assert response.status_code == 422


# ==========================================================
# 4. process_payment() — 결제 처리 로직 단위 테스트
# ==========================================================
class TestProcessPaymentLogic:
    """결제 처리 비즈니스 로직 테스트"""

    def test_process_payment_returns_completed(self):
        """Mock 결제가 항상 COMPLETED를 반환하는지 확인"""
        # GIVEN: 주문 데이터
        order_data = {"orderId": "test-001", "amount": 25000}

        # WHEN: 결제 처리
        result = process_payment(order_data)

        # THEN: COMPLETED 반환
        assert result == "COMPLETED"

    def test_process_payment_with_various_amounts(self):
        """다양한 금액에 대해 결제가 성공하는지 확인"""
        amounts = [100, 1000, 50000, 1000000]
        for amount in amounts:
            result = process_payment({"orderId": f"order-{amount}", "amount": amount})
            assert result == "COMPLETED", f"금액 {amount}원 결제 실패"


# ==========================================================
# 5. on_order_message() — RabbitMQ 메시지 처리 테스트
# ==========================================================
class TestOnOrderMessage:
    """RabbitMQ 메시지 콜백 함수 테스트"""

    @patch("main.requests.post")
    def test_successful_message_sends_ack(self, mock_post):
        """
        정상 메시지 수신 시 콜백 전송 후 ACK를 보내는지 확인

        [제21강 변경] basic_ack 호출 검증 추가
        이전: 콜백 전송만 확인
        이후: 콜백 전송 + ACK 호출까지 확인 (메시지가 큐에서 안전하게 제거됨)
        """
        message_body = json.dumps({
            "orderId": "order-msg-001",
            "amount": 30000,
            "userEmail": "user@test.com"
        }).encode()

        mock_ch = MagicMock()
        mock_method = MagicMock()
        # delivery_tag: RabbitMQ가 각 메시지에 부여한 고유 번호표
        mock_method.delivery_tag = 1

        # [핫픽스] mock_post의 반환값에 status_code 설정 (응답코드 분기 로직 지원)
        mock_post.return_value.status_code = 200

        on_order_message(mock_ch, mock_method, MagicMock(), message_body)

        # 콜백 전송 확인
        mock_post.assert_called_once()
        callback_data = mock_post.call_args[1]["json"]
        assert callback_data["orderId"] == "order-msg-001"
        assert callback_data["paymentStatus"] == "COMPLETED"

        # [제21강 추가] ACK 호출 확인 — 메시지 처리 완료
        mock_ch.basic_ack.assert_called_once_with(delivery_tag=1)
        mock_ch.basic_nack.assert_not_called()

    @patch("main.requests.post")
    def test_callback_failure_sends_nack(self, mock_post):
        """
        콜백 실패 시 NACK을 보내 메시지가 DLQ로 이동하는지 확인

        [제21강 변경] crash 미발생 테스트 → NACK 호출 검증으로 강화
        이전: "crash 없이 성공"만 확인
        이후: basic_nack(requeue=False) 호출 확인 → 메시지가 DLQ로 이동
        """
        mock_post.side_effect = Exception("Connection refused")

        message_body = json.dumps({
            "orderId": "order-fail-001",
            "amount": 10000,
            "userEmail": "fail@test.com"
        }).encode()

        mock_ch = MagicMock()
        mock_method = MagicMock()
        mock_method.delivery_tag = 2

        on_order_message(mock_ch, mock_method, MagicMock(), message_body)

        # NACK 호출 확인 (메시지 → DLQ)
        mock_ch.basic_nack.assert_called_once_with(delivery_tag=2, requeue=False)
        mock_ch.basic_ack.assert_not_called()

    @patch("main.requests.post")
    def test_callback_409_sends_ack(self, mock_post):
        """
        [핫픽스] 콜백 응답이 409(이미 처리됨)일 때 ACK를 보내는지 확인

        409는 "이미 처리된 주문"을 의미하므로 장애가 아닌 정상적인 중복 요청입니다.
        DLQ에 보내면 실제 장애와 구분이 안 되므로 ACK로 처리합니다.
        """
        mock_response = MagicMock()
        mock_response.status_code = 409  # 이미 처리됨
        mock_post.return_value = mock_response

        message_body = json.dumps({
            "orderId": "order-duplicate",
            "amount": 15000,
            "userEmail": "dup@test.com"
        }).encode()

        mock_ch = MagicMock()
        mock_method = MagicMock()
        mock_method.delivery_tag = 4

        on_order_message(mock_ch, mock_method, MagicMock(), message_body)

        # 409는 ACK 처리 (DLQ로 보내지 않음)
        mock_ch.basic_ack.assert_called_once_with(delivery_tag=4)
        mock_ch.basic_nack.assert_not_called()

    @patch("main.requests.post")
    def test_callback_http_500_sends_nack(self, mock_post):
        """
        [핫픽스] 콜백 HTTP 응답이 500일 때 NACK을 보내는지 확인

        5xx는 서버 오류이므로 DLQ로 보내 나중에 재처리합니다.
        """
        mock_response = MagicMock()
        mock_response.status_code = 500  # 서버 오류
        mock_post.return_value = mock_response

        message_body = json.dumps({
            "orderId": "order-http-err",
            "amount": 20000,
            "userEmail": "err@test.com"
        }).encode()

        mock_ch = MagicMock()
        mock_method = MagicMock()
        mock_method.delivery_tag = 3

        on_order_message(mock_ch, mock_method, MagicMock(), message_body)

        mock_ch.basic_nack.assert_called_once_with(delivery_tag=3, requeue=False)
        mock_ch.basic_ack.assert_not_called()


# ==========================================================
# 6. PaymentRequest Pydantic 모델 테스트
# ==========================================================
class TestPaymentRequestModel:
    """Pydantic 요청 모델 검증 테스트"""

    def test_valid_request(self):
        """정상 데이터로 모델 생성이 되는지 확인"""
        req = PaymentRequest(orderId="order-001", amount=50000)
        assert req.orderId == "order-001"
        assert req.amount == 50000

    def test_amount_type_coercion(self):
        """Pydantic이 문자열 숫자를 int로 변환하는지 확인"""
        # Pydantic v2는 기본적으로 "strict" 모드가 아니면 형변환을 시도합니다.
        req = PaymentRequest(orderId="order-002", amount="30000")
        assert req.amount == 30000
