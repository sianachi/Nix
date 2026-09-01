package workerapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestClientDoesNotForwardTheInternalSecretAcrossRedirects(t *testing.T) {
	var targetReached atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		targetReached.Store(true)
		if request.Header.Get("X-Nix-Internal-Secret") != "" {
			t.Fatal("the internal secret crossed an origin redirect")
		}
	}))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		http.Redirect(response, request, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()

	err := New(redirect.URL, "secret", "worker", time.Second).Ping(context.Background())
	if err == nil {
		t.Fatal("the worker API redirect was accepted")
	}
	if targetReached.Load() {
		t.Fatal("the redirect target was contacted")
	}
}

func TestClientLeasesAndAcknowledgesWithInternalCredentials(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Nix-Internal-Secret") != "secret" || request.Header.Get("Authorization") != "" {
			t.Fatal("internal credentials were not forwarded")
		}
		if request.URL.Path == "/internal/worker-dispatch/outbox/lease" {
			_, _ = response.Write([]byte(`[{"id":"event","tenantId":"tenant","kind":"item.changed","payload":{},"attempts":1,"availableAt":"2026-01-01T00:00:00Z"}]`))
			return
		}
		if request.URL.Path == "/internal/worker-dispatch/outbox/event/finish" {
			response.WriteHeader(http.StatusNoContent)
			return
		}
		response.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	client := New(server.URL, "secret", "indexer", time.Second)
	events, err := client.LeaseOutbox(context.Background(), "item.changed", 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("lease = %#v, %v", events, err)
	}
	if err := client.AcknowledgeOutbox(context.Background(), events[0].ID); err != nil {
		t.Fatal(err)
	}
}

func TestPingVerifiesAuthenticatedDispatchInsteadOfPublicHealth(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/worker-dispatch/jobs/lease" {
			t.Fatalf("readiness used %s", request.URL.Path)
		}
		if request.Header.Get("X-Nix-Internal-Secret") != "secret" {
			response.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = response.Write([]byte(`[]`))
	}))
	defer server.Close()

	if err := New(server.URL, "secret", "worker", time.Second).Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := New(server.URL, "wrong", "worker", time.Second).Ping(context.Background()); err == nil {
		t.Fatal("readiness accepted an invalid internal secret")
	}
}

func TestClientClaimsRenewsAndReadsExactJobExecution(t *testing.T) {
	const jobID = "10000000-0000-4000-8000-000000000001"
	const executionID = "worker one:execution/1"
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		if request.Header.Get("X-Nix-Internal-Secret") != "secret" {
			t.Fatal("internal secret was not sent")
		}
		switch requests {
		case 1:
			if request.Method != http.MethodPost || request.URL.Path != "/internal/worker-dispatch/jobs/"+jobID+"/claim" {
				t.Fatalf("unexpected claim request: %s %s", request.Method, request.URL.Path)
			}
			assertExecutionRequest(t, request, executionID, 60)
			_, _ = response.Write([]byte(`{"id":"` + jobID + `","tenantId":"tenant","kind":"import.pdf","payload":{},"attempts":1,"cancellationRequested":false}`))
		case 2:
			if request.Method != http.MethodPost || request.URL.Path != "/internal/worker-dispatch/jobs/"+jobID+"/renew" {
				t.Fatalf("unexpected renewal request: %s %s", request.Method, request.URL.Path)
			}
			assertExecutionRequest(t, request, executionID, 60)
			response.WriteHeader(http.StatusNoContent)
		case 3:
			if request.Method != http.MethodGet || request.URL.Path != "/internal/worker-dispatch/jobs/"+jobID+"/state" || request.URL.Query().Get("owner") != executionID {
				t.Fatalf("unexpected state request: %s %s", request.Method, request.URL.String())
			}
			_, _ = response.Write([]byte(`{"status":"running","cancellationRequested":false,"leaseOwned":true,"leaseUntil":"2026-09-01T00:00:00Z"}`))
		default:
			t.Fatalf("unexpected request %d", requests)
		}
	}))
	defer server.Close()

	client := New(server.URL, "secret", "worker", time.Second)
	job, err := client.ClaimJob(context.Background(), jobID, executionID, 60)
	if err != nil || job == nil || job.ID != jobID {
		t.Fatalf("claim = %#v, %v", job, err)
	}
	renewed, err := client.RenewJob(context.Background(), jobID, executionID, 60)
	if err != nil || !renewed {
		t.Fatalf("renewed = %v, %v", renewed, err)
	}
	state, err := client.JobState(context.Background(), jobID, executionID)
	if err != nil || state == nil || !state.LeaseOwned || state.Status != "running" {
		t.Fatalf("state = %#v, %v", state, err)
	}
}

func TestClientTreatsClaimAndRenewConflictsAsLostWork(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusConflict)
	}))
	defer server.Close()
	client := New(server.URL, "secret", "worker", time.Second)

	job, err := client.ClaimJob(context.Background(), "job", "execution", 60)
	if err != nil || job != nil {
		t.Fatalf("claim = %#v, %v", job, err)
	}
	renewed, err := client.RenewJob(context.Background(), "job", "execution", 60)
	if err != nil || renewed {
		t.Fatalf("renewed = %v, %v", renewed, err)
	}
}

func TestExecutionContextAddsLeaseProofOnlyToDomainRequests(t *testing.T) {
	const jobID = "019946d1-fbc0-7a87-b27e-d2f16408c71a"
	const executionID = "worker:019946d1-fbc1-7d99-9ce7-1c721b406ff0"
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Nix-Worker-Job-Id") != jobID || request.Header.Get("X-Nix-Worker-Execution-Id") != executionID {
			t.Fatalf("execution headers = %q, %q", request.Header.Get("X-Nix-Worker-Job-Id"), request.Header.Get("X-Nix-Worker-Execution-Id"))
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	client := New(server.URL, "secret", "worker", time.Second)

	err := client.post(WithExecution(context.Background(), jobID, executionID), "/internal/worker-executions/probe", nil)
	if err != nil {
		t.Fatal(err)
	}
}

func assertExecutionRequest(t *testing.T, request *http.Request, owner string, leaseSeconds int) {
	t.Helper()
	var body struct {
		Owner        string `json:"owner"`
		LeaseSeconds int    `json:"leaseSeconds"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Owner != owner || body.LeaseSeconds != leaseSeconds {
		t.Fatalf("execution request = %#v", body)
	}
}
