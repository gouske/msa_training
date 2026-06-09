plugins {
    // 1. Kotlin 버전을 1.9.24 또는 2.0.21 정도로 조정
    kotlin("jvm") version "1.9.24"
    kotlin("plugin.spring") version "1.9.24"
    // 2. Spring Boot 버전을 안정적인 3.3.x 또는 3.4.x대로 조정 (4.0.3은 너무 높습니다)
    id("org.springframework.boot") version "3.3.5"
    // 3. 의존성 관리자 버전 조정
    id("io.spring.dependency-management") version "1.1.6"
    kotlin("plugin.jpa") version "1.9.24"
}

group = "com.example"
version = "0.0.1-SNAPSHOT"
description = "auth-service"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

configurations {
    compileOnly {
        extendsFrom(configurations.annotationProcessor.get())
    }
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    implementation("org.springframework.boot:spring-boot-starter-security")

    // [제24강 Phase 2] Spring Boot Actuator + Micrometer Prometheus 레지스트리
    //   Actuator 가 /actuator/prometheus 엔드포인트를 자동 노출.
    //   Micrometer 가 Spring MVC 요청, JVM, HikariCP 등의 메트릭을 자동 수집한다.
    //   별도 미들웨어 작성 없이 4 서비스 중 가장 짧은 경로로 RED 메트릭 + JVM/DB pool 가시성 확보.
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("io.micrometer:micrometer-registry-prometheus")

    // [수정] 아래 한 줄을 정확히 확인하세요.// [중요] starter-webmvc 대신 starter-web을 사용하세요. (mvc를 포함한 표준임)
    // implementation("org.springframework.boot:spring-boot-starter-webmvc")
    implementation("org.springframework.boot:spring-boot-starter-web")

    implementation("org.jetbrains.kotlin:kotlin-reflect")

    // [수정] 그룹 ID를 com.fasterxml로 변경해야 안정적입니다.
    // implementation("tools.jackson.module:jackson-module-kotlin")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin")

    // [제25강 Saga Phase 3] RabbitMQ(Spring AMQP) — saga.points.command consumer + saga.reply publisher.
    //   order-service(amqplib)·payment-service(pika)와 동일한 큐/DLQ 계약으로 통신한다.
    implementation("org.springframework.boot:spring-boot-starter-amqp")

    compileOnly("org.projectlombok:lombok")
    runtimeOnly("org.postgresql:postgresql")
    annotationProcessor("org.projectlombok:lombok")

    // 테스트 의존성: Spring Boot 통합 테스트 + 보안 테스트 + JUnit 5
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.security:spring-security-test")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit5")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")

    // [P1 #1 / @SpringBootTest PostgreSQL 의존 분리]
    // 테스트 시 운영용 PostgreSQL 대신 메모리 안에서 동작하는 H2 를 잡도록 한다.
    // ddl-auto=create-drop 와 결합되어 매 테스트 컨텍스트마다 클린 스키마가 생성·폐기된다.
    // 버전은 Spring Boot 3.3.5 BOM 이 관리하므로 명시하지 않는다.
    testRuntimeOnly("com.h2database:h2")

    // [PR #30 Codex 적대적 리뷰 follow-up — Q1/A]
    // 운영과 동일한 PostgreSQL 15 엔진으로 prod-like contextLoads 를 검증하기 위한
    // Testcontainers. Docker 데몬이 필요하며, AuthProdLikeContextTest 는
    // @EnabledIfEnvironmentVariable("RUN_PROD_LIKE_TESTS", "true") 로 명시 opt-in
    // 일 때만 실행된다 (가벼운 H2 테스트는 항상 통과).
    //
    // Spring Boot 3.3.5 BOM 이 가져오는 1.19.8 은 macOS Docker Desktop 4.x 의 새
    // socket 경로 자동 감지에 일부 실패하는 사례가 있어, 최신 1.21.3 명시.
    testImplementation("org.testcontainers:postgresql:1.21.3")
    testImplementation("org.testcontainers:junit-jupiter:1.21.3")

    // Mockito: 가짜(Mock) 객체를 만들어 단위 테스트에서 외부 의존성을 격리합니다.
    testImplementation("org.mockito:mockito-core:5.14.2")
    testImplementation("org.mockito:mockito-junit-jupiter:5.14.2")

    // MockWebServer: Consul HTTP API를 모의(mock)해서 단위 테스트에서 실제 Consul 없이도 검증합니다.
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("com.squareup.okhttp3:okhttp:4.12.0")

    // JWT 생성을 위한 실무 표준 라이브러리
    implementation("io.jsonwebtoken:jjwt-api:0.12.6")
    runtimeOnly("io.jsonwebtoken:jjwt-impl:0.12.6")
    runtimeOnly("io.jsonwebtoken:jjwt-jackson:0.12.6")
}

kotlin {
    compilerOptions {
        freeCompilerArgs.addAll("-Xjsr305=strict", "-Xannotation-default-target=param-property")
    }
}

allOpen {
    annotation("jakarta.persistence.Entity")
    annotation("jakarta.persistence.MappedSuperclass")
    annotation("jakarta.persistence.Embeddable")
}

tasks.getByName<org.springframework.boot.gradle.tasks.bundling.BootJar>("bootJar") {
    archiveFileName.set("app.jar") // 출력 파일 이름을 app.jar로 고정
}

// 일반 jar 생성을 비활성화하여 혼선을 방지합니다.
tasks.getByName<Jar>("jar") {
    enabled = false
}

tasks.withType<Test> {
    useJUnitPlatform()
}
