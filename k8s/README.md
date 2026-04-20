# Kubernetes 배포 매니페스트 (제22강)

이 디렉토리는 MSA 4개 서비스와 인프라(PostgreSQL · MongoDB · RabbitMQ · Consul) 를
Kubernetes 에 배포하기 위한 매니페스트 모음이다. 로컬 minikube/kind 배포를 기본 가정한다.

## 구성

| 리소스 | 파일 |
|--------|------|
| Namespace | `namespace.yml` |
| ConfigMap | `configmap.yml` |
| Secret (템플릿) | `secrets.example.yml` ← 저장소에 커밋됨 |
| Secret (실제 값) | `secrets.yml` ← `.gitignore` 제외, 로컬 생성 |
| Gateway | `gateway-service/` |
| Auth | `auth-service/` |
| Order | `order-service/` |
| Payment | `payment-service/` |
| Consul | `consul/` |
| PostgreSQL | `databases/postgres-deployment.yml` |
| MongoDB | `databases/mongo-deployment.yml` |
| RabbitMQ | `rabbitmq/deployment.yml` |

## 최초 배포 순서

```bash
# 1) secrets 파일을 로컬에서 복사 후 실제 값으로 교체
cp k8s/secrets.example.yml k8s/secrets.yml
# → secrets.yml 의 POSTGRES_*, JWT_SECRET_KEY, INTERNAL_API_KEY 를
#   실제 값(Base64) 로 교체. 이 파일은 절대 커밋하지 않는다.

# 2) 공통 리소스 생성
kubectl apply -f k8s/namespace.yml
kubectl apply -f k8s/configmap.yml
kubectl apply -f k8s/secrets.yml

# 3) 인프라 배포
kubectl apply -f k8s/consul/
kubectl apply -f k8s/databases/
kubectl apply -f k8s/rabbitmq/

# 4) 서비스 배포 (의존성: auth-db / order-db / rabbitmq / consul 기동 완료 후)
kubectl apply -f k8s/auth-service/
kubectl apply -f k8s/order-service/
kubectl apply -f k8s/payment-service/
kubectl apply -f k8s/gateway-service/

# 5) 상태 확인
kubectl -n msa-training get pods
kubectl -n msa-training get svc
```

## 서비스 디스커버리

Gateway 는 `ConsulProxyConfigProvider` 를 사용해 Consul 에 등록된 auth/order/payment
인스턴스를 폴링하여 YARP 라우팅 대상을 갱신한다. 따라서 **Consul Deployment 가 반드시
클러스터에 존재**해야 하며, 각 서비스는 기동 시 Consul 에 자기 자신을 등록한다.

| 환경 변수 | 대상 | 값 |
|-----------|------|----|
| `CONSUL_HOST` | auth / order / payment | `consul` |
| `CONSUL_PORT` | auth / order / payment | `8500` |
| `CONSUL_SERVICE_ADDRESS` | auth / order / payment | 각 서비스의 K8s Service 이름 |
| `Consul__Address` | gateway | `http://consul:8500` |

## 보안 주의사항

- `secrets.yml` 은 **절대 커밋하지 않는다**. `.gitignore` 에 등록되어 있다.
- 학습용 기본 키(`default-local-test-key-1234567890`, `msa-training-internal-key-2026`) 는
  운영에서 사용하지 말 것. Sealed Secrets · Vault · AWS Secrets Manager 등을 연동해야 한다.
- `k8s/secrets.example.yml` 의 값은 전부 `CHANGE_ME_*` 더미다.

## 데이터 보존

- Postgres / MongoDB / RabbitMQ 는 PersistentVolumeClaim 을 사용한다.
- Pod 재시작/재스케줄링 시 데이터가 유지되지만, 단일 Pod 구성이므로
  운영 환경에서는 StatefulSet 으로 전환하고 백업/복구 전략을 별도 수립해야 한다.
