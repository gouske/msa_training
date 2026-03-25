# 빌드 스테이지
# 로컬의 Java 21 버전과 일치시킵니다.
FROM eclipse-temurin:21-jdk-alpine AS build

WORKDIR /app

COPY . .

# 'jar' 대신 'bootJar'를 실행하는 것이 확실합니다.
RUN ./gradlew clean bootJar

# 실행 스테이지
FROM eclipse-temurin:21-jre-alpine

# 컨테이너 내부 작업 디렉토리
WORKDIR /app

# 빌드된 JAR 파일을 복사 (Gradle/Maven 빌드 결과물)
# 실무 주석: 로컬에서 ./gradlew build 실행 후 생성된 파일을 넣습니다.
# COPY build/libs/*.jar app.jar
# build/libs 폴더에서 plain이 붙지 않은 실행 가능한 jar만 복사합니다.
COPY --from=build /app/build/libs/app.jar app.jar

# 실행 명령
ENTRYPOINT ["java", "-jar", "app.jar"]

# [설명] eclipse-temurin은 실무에서 가장 안정적으로 쓰이는 Java 베이스 이미지입니다.