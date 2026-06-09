"""
PaymentLedger — 결제 원장(MongoDB) repository.

학습 포인트(25강 핵심):
  - 결제는 "되돌릴 수 없는 부수효과"입니다. 같은 명령이 재전송돼도(네트워크 재시도,
    메시지 중복) 결제가 두 번 일어나면 안 됩니다 → 멱등키(sagaId:stepName)로 막습니다.
  - 멱등키에 unique index를 걸고, insert가 중복으로 실패하면 기존 결과를 재사용합니다.
    이렇게 하면 동시에 같은 명령이 들어와도(race) 결제는 정확히 한 번만 일어납니다.
  - 환불은 "결제를 안 한 것"으로 되돌리는 게 아니라, status를 REFUNDED로 바꾸는
    의미적 취소(semantic undo)입니다.
"""
from uuid import uuid4

from pymongo.errors import DuplicateKeyError


class PaymentLedger:
    """결제 원장. 컬렉션을 주입받아 멱등 charge/refund를 제공한다."""

    def __init__(self, collection):
        """
        @param collection: pymongo(또는 mongomock) 컬렉션 — payment_db.payments
        """
        self._col = collection
        # 멱등키 unique index — 같은 sagaId:stepName 결제 명령의 중복 insert를 DB가 차단한다.
        self._col.create_index("idempotencyKey", unique=True)

    @staticmethod
    def _idem_key(saga_id: str, step_name: str) -> str:
        """
        멱등키 생성: sagaId와 stepName을 조합.
        @returns 멱등키 (예: "saga-1:T2_PAYMENT")
        """
        return f"{saga_id}:{step_name}"

    def charge(self, saga_id: str, step_name: str, order_id: str, amount: int) -> str:
        """
        결제를 수행하고 paymentId를 반환한다. 이미 처리한 명령이면 기존 paymentId를 그대로 반환.
        @param saga_id: Saga 트랜잭션 ID
        @param step_name: 이 단계의 고유명 (STEP.PAYMENT 등)
        @param order_id: 주문 ID
        @param amount: 결제 금액 (단위: 원)
        @returns paymentId (환불 시 식별자로 사용)
        """
        idem = self._idem_key(saga_id, step_name)

        # 멱등성: 이미 이 명령이 처리됐으면 기존 결과를 반환
        existing = self._col.find_one({"idempotencyKey": idem})
        if existing is not None:
            return existing["paymentId"]

        # 신규 결제 → paymentId 생성 및 insert
        payment_id = "PAY-" + uuid4().hex
        try:
            self._col.insert_one({
                "paymentId": payment_id,
                "sagaId": saga_id,
                "orderId": order_id,
                "amount": amount,
                "status": "CHARGED",
                "idempotencyKey": idem,
            })
        except DuplicateKeyError:
            # 레이스 조건: 동시에 같은 명령이 들어와 다른 처리자가 먼저 insert한 경우
            # → 기존 결과 재사용
            return self._col.find_one({"idempotencyKey": idem})["paymentId"]

        return payment_id

    def refund(self, payment_id: str) -> None:
        """
        결제를 환불 상태(REFUNDED)로 전환한다.
        이미 REFUNDED여도, 없는 결제여도 안전(멱등).
        @param payment_id: 환불할 결제 ID
        """
        self._col.update_one(
            {"paymentId": payment_id},
            {"$set": {"status": "REFUNDED"}},
        )

    def find_by_payment_id(self, payment_id: str):
        """
        paymentId로 원장 레코드를 조회한다.
        @returns 원장 레코드 dict, 또는 None
        """
        return self._col.find_one({"paymentId": payment_id})

    def count(self) -> int:
        """
        원장 레코드 수. 테스트 검증용.
        @returns 현재 컬렉션의 문서 개수
        """
        return self._col.count_documents({})
