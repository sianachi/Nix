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
	MaxTokens      int
	RequestTimeout time.Duration
}

func Load(getenv func(string) string) (Settings, error) {
	maxInputBytes, err := parseInt64(getenv("NIX_WORKER_MAX_INPUT_BYTES"), 64*1024*1024)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_WORKER_MAX_INPUT_BYTES: %w", err)
	}
	maxLineBytes, err := parseInt(getenv("NIX_WORKER_MAX_LINE_BYTES"), 4*1024*1024)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_WORKER_MAX_LINE_BYTES: %w", err)
	}
	maxRecords, err := parseInt(getenv("NIX_WORKER_MAX_RECORDS"), 100_000)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_WORKER_MAX_RECORDS: %w", err)
	}
	maxTokens, err := parseInt(getenv("NIX_WORKER_MAX_TOKENS_PER_RECORD"), 20_000)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_WORKER_MAX_TOKENS_PER_RECORD: %w", err)
	}
	requestTimeoutSeconds, err := parseInt(getenv("NIX_WORKER_REQUEST_TIMEOUT_SECONDS"), 60)
	if err != nil {
		return Settings{}, fmt.Errorf("NIX_WORKER_REQUEST_TIMEOUT_SECONDS: %w", err)
	}
	settings := Settings{
		Address:        valueOr(getenv("NIX_WORKER_ADDRESS"), ":8301"),
		InternalSecret: getenv("NIX_WORKER_INTERNAL_SECRET"),
		MaxInputBytes:  maxInputBytes,
		MaxLineBytes:   maxLineBytes,
		MaxRecords:     maxRecords,
		MaxTokens:      maxTokens,
		RequestTimeout: time.Duration(requestTimeoutSeconds) * time.Second,
	}
	if settings.MaxInputBytes <= 0 || settings.MaxLineBytes <= 0 || settings.MaxRecords <= 0 || settings.MaxTokens <= 0 || settings.RequestTimeout <= 0 {
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

func parseInt(value string, fallback int) (int, error) {
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, err
	}
	return parsed, nil
}

func parseInt64(value string, fallback int64) (int64, error) {
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, err
	}
	return parsed, nil
}
