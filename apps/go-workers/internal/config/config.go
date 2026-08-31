package config

import (
	"fmt"
	"strconv"
	"time"
)

type Settings struct {
	Address        string
	InternalSecret string
	MaxInputBytes  int64
	MaxLineBytes   int
	MaxRecords     int
	RequestTimeout time.Duration
}

func Load(getenv func(string) string) (Settings, error) {
	settings := Settings{
		Address:        valueOr(getenv("NIX_WORKER_ADDRESS"), ":8301"),
		InternalSecret: getenv("NIX_WORKER_INTERNAL_SECRET"),
		MaxInputBytes:  parseInt64(getenv("NIX_WORKER_MAX_INPUT_BYTES"), 64*1024*1024),
		MaxLineBytes:   parseInt(getenv("NIX_WORKER_MAX_LINE_BYTES"), 4*1024*1024),
		MaxRecords:     parseInt(getenv("NIX_WORKER_MAX_RECORDS"), 100_000),
		RequestTimeout: time.Duration(parseInt(getenv("NIX_WORKER_REQUEST_TIMEOUT_SECONDS"), 60)) * time.Second,
	}
	if settings.MaxInputBytes <= 0 || settings.MaxLineBytes <= 0 || settings.MaxRecords <= 0 || settings.RequestTimeout <= 0 {
		return Settings{}, fmt.Errorf("worker limits and timeout must be positive")
	}
	return settings, nil
}

func valueOr(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func parseInt(value string, fallback int) int {
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func parseInt64(value string, fallback int64) int64 {
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return fallback
	}
	return parsed
}
