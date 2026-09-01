package workerapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/broker"
	"github.com/sianachi/Nix/apps/go-workers/internal/pluginworker"
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

func TestClientObtainsExportSourceAndSizedDestinationUnderTheExecution(t *testing.T) {
	const jobID = "019946d1-fbc0-7a87-b27e-d2f16408c71b"
	const executionID = "worker:019946d1-fbc1-7d99-9ce7-1c721b406ff1"
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		if request.Header.Get("X-Nix-Worker-Job-Id") != jobID || request.Header.Get("X-Nix-Worker-Execution-Id") != executionID {
			t.Fatal("execution proof was omitted")
		}
		if requests == 1 {
			_, _ = response.Write([]byte(`{"exportId":"` + jobID + `","format":"pdf","sourceUrl":"http://collab/bundle","bearerToken":"token","delegationExpiresAt":"2026-09-01T01:00:00Z"}`))
			return
		}
		if request.URL.Query().Get("byteLength") != "123" || request.URL.Query().Get("sha256") != strings.Repeat("a", 64) {
			t.Fatalf("destination query = %s", request.URL.RawQuery)
		}
		_, _ = response.Write([]byte(`{"exportId":"` + jobID + `","attemptId":"33333333-3333-4333-8333-333333333333","format":"pdf","objectKey":"exports/result.pdf","uploadUrl":"http://objects/put","readUrl":"http://objects/get","deleteUrl":"http://objects/delete","capabilityExpiresAt":"2026-09-01T01:00:00Z"}`))
	}))
	defer server.Close()
	client := New(server.URL, "secret", "worker", time.Second)
	ctx := WithExecution(context.Background(), jobID, executionID)
	if source, err := client.GetExportSource(ctx, jobID); err != nil || source.Format != "pdf" {
		t.Fatalf("source = %#v, %v", source, err)
	}
	if destination, err := client.GetExportDestination(ctx, jobID, 123, strings.Repeat("a", 64)); err != nil || destination.ObjectKey == "" {
		t.Fatalf("destination = %#v, %v", destination, err)
	}
}

func TestClientHydratesScopedIndexMetadataAndBoundedBody(t *testing.T) {
	const tenantID = "20000000-0000-4000-8000-000000000002"
	const itemID = "40000000-0000-4000-8000-000000000004"
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		if request.Header.Get("X-Nix-Internal-Secret") != "secret" || request.Header.Get("Authorization") != "" {
			t.Fatal("index hydration did not use only the internal credential")
		}
		expected := "/internal/worker-dispatch/index/items/" + tenantID + "/" + itemID
		if requests == 1 {
			if request.Method != http.MethodGet || request.URL.Path != expected || request.Header.Get("Accept") != "application/json" {
				t.Fatalf("metadata request = %s %s", request.Method, request.URL.Path)
			}
			response.Header().Set("Content-Type", "application/json; charset=utf-8")
			_, _ = response.Write([]byte(`{"tenant_id":"` + tenantID + `","workspace_id":"30000000-0000-4000-8000-000000000003","item_id":"` + itemID + `","parent_id":null,"item_type":"note","title":"Item","property_text":"status open","properties":{"status":"open"},"ancestor_ids":[],"links":[],"authorization_keys":["workspace:30000000-0000-4000-8000-000000000003"],"lifecycle_state":"active","indexable":true,"source_updated_at":"2026-09-01T12:00:00Z"}`))
			return
		}
		if request.Method != http.MethodGet || request.URL.Path != expected+"/body" || request.Header.Get("Accept") != "text/plain" {
			t.Fatalf("body request = %s %s", request.Method, request.URL.Path)
		}
		response.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = response.Write([]byte("bounded body"))
	}))
	defer server.Close()
	client := New(server.URL, "secret", "indexer", time.Second)
	metadata, err := client.GetIndexItemMetadata(context.Background(), tenantID, itemID)
	if err != nil || metadata == nil || metadata.ItemID != itemID || metadata.ItemType != "note" || !metadata.Indexable || metadata.AuthorizationKeys[0] != "workspace:30000000-0000-4000-8000-000000000003" {
		t.Fatalf("metadata = %#v, %v", metadata, err)
	}
	body, err := client.GetIndexItemBody(context.Background(), tenantID, itemID)
	if err != nil || body == nil || *body != "bounded body" {
		t.Fatalf("body = %#v, %v", body, err)
	}
}

func TestIndexHydrationDistinguishesGoneAndBodylessItems(t *testing.T) {
	responses := []int{http.StatusNotFound, http.StatusNoContent, http.StatusNotFound}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(responses[0])
		responses = responses[1:]
	}))
	defer server.Close()
	client := New(server.URL, "secret", "indexer", time.Second)
	if metadata, err := client.GetIndexItemMetadata(context.Background(), "tenant", "item"); err != nil || metadata != nil {
		t.Fatalf("metadata = %#v, %v", metadata, err)
	}
	body, err := client.GetIndexItemBody(context.Background(), "tenant", "item")
	if err != nil || body == nil || *body != "" {
		t.Fatalf("bodyless = %#v, %v", body, err)
	}
	body, err = client.GetIndexItemBody(context.Background(), "tenant", "item")
	if err != nil || body != nil {
		t.Fatalf("gone body = %#v, %v", body, err)
	}
}

func TestIndexBodyRefusesOversizeWrongMediaAndInvalidUTF8(t *testing.T) {
	for name, handler := range map[string]http.HandlerFunc{
		"oversize": func(response http.ResponseWriter, _ *http.Request) {
			response.Header().Set("Content-Type", "text/plain")
			response.Header().Set("Content-Length", fmt.Sprint(MaxIndexBodyBytes+1))
			_, _ = response.Write(make([]byte, MaxIndexBodyBytes+1))
		},
		"wrong media": func(response http.ResponseWriter, _ *http.Request) {
			response.Header().Set("Content-Type", "text/html")
			_, _ = response.Write([]byte("body"))
		},
		"invalid UTF-8": func(response http.ResponseWriter, _ *http.Request) {
			response.Header().Set("Content-Type", "text/plain")
			_, _ = response.Write([]byte{0xff})
		},
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(handler)
			defer server.Close()
			if body, err := New(server.URL, "secret", "indexer", time.Second).GetIndexItemBody(context.Background(), "tenant", "item"); err == nil || body != nil {
				t.Fatalf("body = %#v, error = %v", body, err)
			}
		})
	}
}

func TestClientForwardsRestartableRebuildCursorAndReadsQueueStatus(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		if request.Header.Get("X-Nix-Internal-Secret") != "secret" {
			t.Fatal("internal secret was omitted")
		}
		response.Header().Set("Content-Type", "application/json")
		if requests == 1 {
			if request.Method != http.MethodPost || request.URL.Path != "/internal/worker-dispatch/index/rebuild" {
				t.Fatalf("rebuild request = %s %s", request.Method, request.URL.Path)
			}
			var rebuild IndexRebuildRequest
			if err := json.NewDecoder(request.Body).Decode(&rebuild); err != nil || rebuild.AfterTenantID == nil || *rebuild.AfterTenantID != "10000000-0000-4000-8000-000000000001" || rebuild.AfterItemID == nil || *rebuild.AfterItemID != "20000000-0000-4000-8000-000000000002" || rebuild.Limit == nil || *rebuild.Limit != 250 {
				t.Fatalf("rebuild = %#v, %v", rebuild, err)
			}
			_, _ = response.Write([]byte(`{"enqueued":250,"nextTenantId":"30000000-0000-4000-8000-000000000003","nextItemId":"40000000-0000-4000-8000-000000000004","hasMore":true}`))
			return
		}
		if request.Method != http.MethodGet || request.URL.Path != "/internal/worker-dispatch/index/status" {
			t.Fatalf("status request = %s %s", request.Method, request.URL.Path)
		}
		_, _ = response.Write([]byte(`{"pending":12,"oldestAvailableAt":"2026-09-01T12:00:00Z","highestAttempts":3,"pendingFailures":2}`))
	}))
	defer server.Close()
	tenant := "10000000-0000-4000-8000-000000000001"
	item := "20000000-0000-4000-8000-000000000002"
	limit := 250
	client := New(server.URL, "secret", "indexer", time.Second)
	page, err := client.EnqueueIndexRebuild(context.Background(), IndexRebuildRequest{AfterTenantID: &tenant, AfterItemID: &item, Limit: &limit})
	if err != nil || page.Enqueued != 250 || !page.HasMore || page.NextItemID == nil {
		t.Fatalf("page = %#v, %v", page, err)
	}
	status, err := client.GetIndexStatus(context.Background())
	if err != nil || status.Pending != 12 || status.PendingFailures != 2 || status.OldestAvailableAt == nil {
		t.Fatalf("status = %#v, %v", status, err)
	}
}

func TestIndexControlResponsesAreStrictAndBounded(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"pending":1,"oldestAvailableAt":null,"highestAttempts":0,"pendingFailures":0,"unexpected":true}`))
	}))
	defer server.Close()
	if _, err := New(server.URL, "secret", "indexer", time.Second).GetIndexStatus(context.Background()); err == nil {
		t.Fatal("unknown status field was accepted")
	}
}

func TestClientPreparesCallsAndCompletesAnExactPluginInvocation(t *testing.T) {
	const eventID = "10000000-0000-4000-8000-000000000001"
	const tenantID = "20000000-0000-4000-8000-000000000002"
	const workspaceID = "30000000-0000-4000-8000-000000000003"
	const itemID = "40000000-0000-4000-8000-000000000004"
	const invocationID = "50000000-0000-4000-8000-000000000005"
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		if request.Header.Get("X-Nix-Internal-Secret") != "secret" {
			t.Fatal("internal secret was omitted")
		}
		response.Header().Set("Content-Type", "application/json")
		switch requests {
		case 1:
			if request.URL.Path != "/internal/worker-dispatch/plugins/events/"+eventID+"/prepare" {
				t.Fatalf("prepare path = %s", request.URL.Path)
			}
			var body struct {
				CausationID  string `json:"causationId"`
				LeaseSeconds int    `json:"leaseSeconds"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil || body.CausationID != eventID || body.LeaseSeconds != 60 {
				t.Fatalf("prepare body = %#v, %v", body, err)
			}
			publicKey := base64.StdEncoding.EncodeToString(make([]byte, 32))
			signature := base64.StdEncoding.EncodeToString(make([]byte, 64))
			_, _ = response.Write([]byte(`{"outcome":"prepared","plans":[{"invocationId":"` + invocationID + `","installationId":"60000000-0000-4000-8000-000000000006","attempt":1,"leaseUntil":"2026-09-01T12:01:00Z","component":{"publisherId":"nix.test","id":"nix.test/example","version":"1.0.0","sha256":"` + strings.Repeat("A", 64) + `","publicKey":"` + publicKey + `","signature":"` + signature + `","downloadUrl":"http://objects/component","downloadExpiresAt":"2026-09-01T12:01:00Z","byteLength":51},"capabilities":["items.read-metadata"]}]}`))
		case 2:
			if request.URL.Path != "/internal/worker-dispatch/plugins/invocations/"+invocationID+"/host-calls" {
				t.Fatalf("host call path = %s", request.URL.Path)
			}
			_, _ = response.Write([]byte(`{"result":{"itemId":"` + itemID + `"}}`))
		case 3:
			if request.URL.Path != "/internal/worker-dispatch/plugins/invocations/"+invocationID+"/complete" {
				t.Fatalf("completion path = %s", request.URL.Path)
			}
			_, _ = response.Write([]byte(`{"outcome":"applied","shouldRequeue":false}`))
		default:
			t.Fatalf("unexpected request %d", requests)
		}
	}))
	defer server.Close()

	client := New(server.URL, "secret", "plugin", time.Second)
	version := int64(7)
	preparation, err := client.PreparePluginEvent(context.Background(), broker.WorkspaceEvent{
		MessageID: eventID, OccurredAt: time.Now(), TenantID: tenantID, WorkspaceID: workspaceID,
		ItemID: itemID, Kind: "item.changed", AggregateVersion: &version,
	}, 60)
	if err != nil || preparation.Outcome != "prepared" || len(preparation.Plans) != 1 || len(preparation.Plans[0].Component.PublicKey) != 32 {
		t.Fatalf("preparation = %#v, %v", preparation, err)
	}
	result, err := client.CallPluginHost(context.Background(), invocationID, "items.read-metadata", json.RawMessage(`{"itemId":"`+itemID+`"}`))
	if err != nil || !json.Valid(result) {
		t.Fatalf("host result = %s, %v", result, err)
	}
	completion, err := client.CompletePluginInvocation(context.Background(), invocationID, pluginworker.Completion{Succeeded: true})
	if err != nil || completion.Outcome != "applied" || completion.ShouldRequeue {
		t.Fatalf("completion = %#v, %v", completion, err)
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
