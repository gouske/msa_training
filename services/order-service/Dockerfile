# 로컬의 Node.js 24 버전과 일치시킵니다.
FROM node:24-alpine

WORKDIR /app

# 라이브러리 설치를 위해 설정 파일 먼저 복사
COPY package*.json ./

# 의존성 설치
RUN npm install

# 전체 소스 코드 복사
COPY . .

# 서비스 실행
CMD ["node", "index.js"]

# [설명] alpine 이미지는 용량이 매우 작아(약 50MB) 배포 속도가 빠릅니다.