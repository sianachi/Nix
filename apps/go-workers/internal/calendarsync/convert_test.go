package calendarsync

import (
	"log/slog"
	"testing"
	"time"
)

func TestBoundWireAllDay(t *testing.T) {
	bound := Bound{AllDay: true, Date: "2026-09-29"}
	if got := bound.Wire(); got != "2026-09-29" {
		t.Fatalf("Wire() = %q, want 2026-09-29", got)
	}
}

func TestBoundWireTimed(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatalf("load location: %v", err)
	}
	instant := time.Date(2026, 9, 29, 14, 30, 0, 0, time.UTC).In(loc)
	bound := Bound{Instant: instant, Zone: "America/New_York"}
	got := bound.Wire()
	want := "2026-09-29T10:30:00-04:00[America/New_York]"
	if got != want {
		t.Fatalf("Wire() = %q, want %q", got, want)
	}
}

func TestParseBoundRoundTripsAllDay(t *testing.T) {
	bound, err := ParseBound("2026-09-29")
	if err != nil {
		t.Fatalf("ParseBound: %v", err)
	}
	if !bound.AllDay || bound.Date != "2026-09-29" {
		t.Fatalf("ParseBound = %+v, want an all-day 2026-09-29 bound", bound)
	}
	if got := bound.Wire(); got != "2026-09-29" {
		t.Fatalf("round-trip Wire() = %q, want 2026-09-29", got)
	}
}

func TestParseBoundRoundTripsTimed(t *testing.T) {
	value := "2026-09-29T10:30:00-04:00[America/New_York]"
	bound, err := ParseBound(value)
	if err != nil {
		t.Fatalf("ParseBound: %v", err)
	}
	if bound.AllDay || bound.Zone != "America/New_York" {
		t.Fatalf("ParseBound = %+v, want a timed America/New_York bound", bound)
	}
	if got := bound.Wire(); got != value {
		t.Fatalf("round-trip Wire() = %q, want %q", got, value)
	}
}

func TestParseBoundRejectsGarbage(t *testing.T) {
	for _, value := range []string{"", "not-a-date", "2026-09-29T10:30:00", "2026-09-29T10:30:00-04:00[Not/AZone]"} {
		if _, err := ParseBound(value); err == nil {
			t.Fatalf("ParseBound(%q) succeeded, want an error", value)
		}
	}
}

func TestInclusiveEndDateIsExclusiveEndMinusOneDay(t *testing.T) {
	inclusive, err := InclusiveEndDate("2026-10-01")
	if err != nil {
		t.Fatalf("InclusiveEndDate: %v", err)
	}
	if inclusive != "2026-09-30" {
		t.Fatalf("InclusiveEndDate(2026-10-01) = %q, want 2026-09-30", inclusive)
	}
}

func TestInclusiveEndDateOneDayEventEqualsStart(t *testing.T) {
	// A one-day all-day event has an exclusive end equal to start+1 day; its inclusive end must
	// equal its start.
	start := "2026-09-29"
	exclusiveEnd, err := ExclusiveEndDate(start)
	if err != nil {
		t.Fatalf("ExclusiveEndDate: %v", err)
	}
	if exclusiveEnd != "2026-09-30" {
		t.Fatalf("ExclusiveEndDate(%q) = %q, want 2026-09-30", start, exclusiveEnd)
	}
	inclusive, err := InclusiveEndDate(exclusiveEnd)
	if err != nil {
		t.Fatalf("InclusiveEndDate: %v", err)
	}
	if inclusive != start {
		t.Fatalf("round trip InclusiveEndDate(ExclusiveEndDate(%q)) = %q, want %q", start, inclusive, start)
	}
}

func TestExclusiveEndDateInverseOfInclusiveEndDate(t *testing.T) {
	exclusive := "2026-10-05"
	inclusive, err := InclusiveEndDate(exclusive)
	if err != nil {
		t.Fatalf("InclusiveEndDate: %v", err)
	}
	roundTrip, err := ExclusiveEndDate(inclusive)
	if err != nil {
		t.Fatalf("ExclusiveEndDate: %v", err)
	}
	if roundTrip != exclusive {
		t.Fatalf("round trip = %q, want %q", roundTrip, exclusive)
	}
}

func TestWindowsToIANACommonZones(t *testing.T) {
	cases := map[string]string{
		"Eastern Standard Time": "America/New_York",
		"GMT Standard Time":     "Europe/London",
		"India Standard Time":   "Asia/Kolkata",
		"Tokyo Standard Time":   "Asia/Tokyo",
	}
	for windowsName, want := range cases {
		if got := WindowsToIANA(windowsName, nil); got != want {
			t.Errorf("WindowsToIANA(%q) = %q, want %q", windowsName, got, want)
		}
	}
}

func TestWindowsToIANAFallsBackToUTCAndLogs(t *testing.T) {
	logger := slog.Default()
	if got := WindowsToIANA("Not A Real Windows Zone", logger); got != "UTC" {
		t.Fatalf("WindowsToIANA(unknown) = %q, want UTC", got)
	}
	if got := WindowsToIANA("", logger); got != "UTC" {
		t.Fatalf("WindowsToIANA(empty) = %q, want UTC", got)
	}
}
