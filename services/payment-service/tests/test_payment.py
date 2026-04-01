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
    def test_successful_message_processing(self, mock_post):
        """정상 메시지 수신 시 결제 처리 후 Order Service에 콜백하는지 확인"""
        # GIVEN: RabbitMQ에서 수신한 메시지 (bytes)
        message_body = json.dumps({
            "orderId": "order-msg-001",
            "amount": 30000,
            "userEmail": "user@test.com"
        }).encode()

        # mock channel, method, properties (pika 콜백 파라미터)
        mock_ch = MagicMock()
        mock_method = MagicMock()
        mock_properties = MagicMock()

        # WHEN: 메시지 콜백 실행
        on_order_message(mock_ch, mock_method, mock_properties, message_body)

        # THEN: Order Service에 콜백 요청이 전송됨
        mock_post.assert_called_once()
        call_args = mock_post.call_args

        # 콜백 URL 확인
        assert "/api/order/callback" in call_args[0][0] or \
               "/api/order/callback" in str(call_args)

        # 콜백 본문에 orderId와 paymentStatus가 포함되는지 확인
        callback_data = call_args[1]["json"]
        assert callback_data["orderId"] == "order-msg-001"
        assert callback_data["paymentStatus"] == "COMPLETED"

    @patch("main.requests.post")
    def test_callback_failure_does_not_crash(self, mock_post):
        """Order Service 콜백 실패 시 consumer가 멈추지 않는지 확인"""
        # GIVEN: 콜백 요청이 예외를 던짐 (Order Service 다운)
        mock_post.side_effect = Exception("Connection refused")

        message_body = json.dumps({
            "orderId": "order-fail-001",
            "amount": 10000,
            "userEmail": "fail@test.com"
        }).encode()

        # WHEN & THEN: 예외가 발생해도 함수가 정상 종료됨 (crash 없음)
        # on_order_message 내부에서 try-except로 처리되므로 예외가 전파되지 않아야 합니다.
        on_order_message(MagicMock(), MagicMock(), MagicMock(), message_body)
        # 여기까지 도달하면 crash 없이 성공


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
