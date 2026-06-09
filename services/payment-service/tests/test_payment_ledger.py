"""
[테스트] PaymentLedger — 결제 원장 멱등성.

학습 포인트:
  - 같은 결제 명령(sagaId+stepName)이 두 번 와도 결제는 한 번만 일어나야 합니다.
  - mongomock으로 실제 MongoDB 없이 인메모리에서 동작을 검증합니다.
"""
import mongomock
import pytest

from payment_ledger import PaymentLedger


@pytest.fixture
def ledger():
    """인메모리 mongo 컬렉션을 주입한 PaymentLedger"""
    collection = mongomock.MongoClient().payment_db.payments
    return PaymentLedger(collection)


class TestCharge:
    def test_charge_creates_payment_and_returns_id(self, ledger):
        payment_id = ledger.charge("saga-1", "T2_PAYMENT", "order-1", 10000)

        assert payment_id.startswith("PAY-")
        record = ledger.find_by_payment_id(payment_id)
        assert record["status"] == "CHARGED"
        assert record["sagaId"] == "saga-1"
        assert record["amount"] == 10000

    def test_charge_is_idempotent_for_same_key(self, ledger):
        first = ledger.charge("saga-1", "T2_PAYMENT", "order-1", 10000)
        second = ledger.charge("saga-1", "T2_PAYMENT", "order-1", 10000)

        # 같은 sagaId+stepName → 같은 paymentId, 원장에는 1건만
        assert first == second
        assert ledger.count() == 1

    def test_different_saga_creates_distinct_payments(self, ledger):
        a = ledger.charge("saga-1", "T2_PAYMENT", "order-1", 10000)
        b = ledger.charge("saga-2", "T2_PAYMENT", "order-2", 20000)

        assert a != b
        assert ledger.count() == 2


class TestRefund:
    def test_refund_marks_payment_refunded(self, ledger):
        payment_id = ledger.charge("saga-1", "T2_PAYMENT", "order-1", 10000)

        ledger.refund(payment_id)

        assert ledger.find_by_payment_id(payment_id)["status"] == "REFUNDED"

    def test_refund_is_idempotent(self, ledger):
        payment_id = ledger.charge("saga-1", "T2_PAYMENT", "order-1", 10000)

        ledger.refund(payment_id)
        ledger.refund(payment_id)  # 두 번 호출해도 안전

        assert ledger.find_by_payment_id(payment_id)["status"] == "REFUNDED"

    def test_refund_unknown_payment_is_noop(self, ledger):
        # 존재하지 않는 결제 환불은 예외 없이 무시(멱등)
        ledger.refund("PAY-does-not-exist")
        assert ledger.count() == 0
