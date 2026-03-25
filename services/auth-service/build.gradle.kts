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

    // [수정] 아래 한 줄을 정확히 확인하세요.// [중요] starter-webmvc 대신 starter-web을 사용하세요. (mvc를 포함한 표준임)
    // implementation("org.springframework.boot:spring-boot-starter-webmvc")
    implementation("org.springframework.boot:spring-boot-starter-web")

    implementation("org.jetbrains.kotlin:kotlin-reflect")

    // [수정] 그룹 ID를 com.fasterxml로 변경해야 안정적입니다.
    // implementation("tools.jackson.module:jackson-module-kotlin")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin")

    compileOnly("org.projectlombok:lombok")
    runtimeOnly("org.postgresql:postgresql")
    annotationProcessor("org.projectlombok:lombok")

    // 테스트 의존성들도 버전에 맞게 자동 관리되도록 수정
    testImplementation("org.springframework.boot:spring-boot-starter-data-jpa-test")
    testImplementation("org.springframework.boot:spring-boot-starter-security-test")
    testImplementation("org.springframework.boot:spring-boot-starter-web-test")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit5")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")

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
