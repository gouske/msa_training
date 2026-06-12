package com.example.auth.points.domain

/** 포인트 계정 상태. SUSPENDED(정지) 계정은 포인트 적립을 거절한다. */
enum class PointAccountStatus { ACTIVE, SUSPENDED }
