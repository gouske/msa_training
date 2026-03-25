# 로컬의 Python 3.13 버전과 일치시킵니다.
FROM python:3.13-slim

WORKDIR /app

# 필요한 패키지 목록 복사
COPY requirements.txt .

# 패키지 설치
RUN pip install --no-cache-dir -r requirements.txt

# 소스 코드 복사
COPY . .

# FastAPI 또는 Flask 실행 (예시: main.py)
CMD ["python", "main.py"]

# [설명] --no-cache-dir 옵션은 컨테이너 용량을 줄이기 위한 실무적 팁입니다.