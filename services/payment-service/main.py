from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

# 결제 요청 데이터를 담는 바구니(Schema)
class PaymentRequest(BaseModel):
    orderId: str
    amount: int

@app.get("/api/payment/health")
def health_check():
    return {"status": "OK", "message": "✅ Payment Service is Running on Python!"}

@app.post("/api/payment/process")
async def process_payment(request: PaymentRequest):
    # 실무 시나리오: 여기서 실제 카드사 API를 호출하거나 결제 로직을 수행합니다.
    print(f"💰 결제 진행 중... 주문번호: {request.orderId}, 금액: {request.amount}")
    
    # 지금은 가상으로 무조건 성공시킨다고 가정합니다.
    return {
        "paymentId": "PAY-" + request.orderId,
        "status": "COMPLETED",
        "message": f"{request.amount}원 결제가 완료되었습니다."
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8082) # 결제 서비스는 8082번 포트를 씁니다!