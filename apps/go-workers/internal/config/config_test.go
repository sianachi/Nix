package config

import "testing"

func TestLoadUsesSafeDefaults(t *testing.T) {
	settings, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if settings.MaxInputBytes <= 0 || settings.MaxLineBytes <= 0 || settings.MaxRecords <= 0 {
		t.Fatalf("invalid defaults: %+v", settings)
	}
}

func TestLoadRejectsNonPositiveLimits(t *testing.T) {
	settings, err := Load(func(key string) string {
		if key == "NIX_WORKER_MAX_RECORDS" {
			return "0"
		}
		return ""
	})
	if err == nil || settings.MaxRecords != 0 {
		t.Fatalf("Load() = %+v, %v; want invalid zero limit", settings, err)
	}
}
