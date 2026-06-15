// Order Service Jest 설정
module.exports = {
  testPathIgnorePatterns: [
    '/node_modules/',
    // [Phase 4a] 테스트 헬퍼(공유 유틸) — 테스트 파일이 아니므로 스위트 수집에서 제외한다.
    '<rootDir>/__tests__/helpers/',
  ],
};
