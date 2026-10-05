package templatefilecopy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

const (
	jobID      = "10000000-0000-4000-8000-000000000001"
	ownerID    = "20000000-0000-4000-8000-000000000002"
	transferID = "30000000-0000-4000-8000-000000000003"
	sourceID   = "40000000-0000-4000-8000-000000000004"
	targetID   = "50000000-0000-4000-8000-000000000005"
	execution  = "worker:0123456789abcdef"
)

func TestCopiesVerifiesAndAcknowledgesOnlyAfterVerifiedBytes(t *testing.T) {
	state := newFixture(t, []byte("attachment"), false)
	result, err := state.handler().Handle(state.context(), state.job())
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := result.(Result); !ok || got.TransfersVerified != 1 {
		t.Fatalf("result = %#v", result)
	}
	if state.puts.Load() != 1 || state.completions.Load() != 1 || !state.completeAfterVerified.Load() {
		t.Fatalf("puts=%d completions=%d verified-before-complete=%v", state.puts.Load(), state.completions.Load(), state.completeAfterVerified.Load())
	}
}

func TestReplayVerifiesExistingImmutableObjectAndAcknowledges(t *testing.T) {
	state := newFixture(t, []byte("attachment"), true)
	result, err := state.handler().Handle(state.context(), state.job())
	if err != nil {
		t.Fatal(err)
	}
	if result == nil || state.puts.Load() != 0 || state.completions.Load() != 1 || !state.completeAfterVerified.Load() {
		t.Fatalf("result=%#v puts=%d completions=%d verified-before-complete=%v", result, state.puts.Load(), state.completions.Load(), state.completeAfterVerified.Load())
	}
}

func TestVerifiedDestinationRecoversWhenSourceHasDisappeared(t *testing.T) {
	state := newFixture(t, []byte("attachment"), true)
	state.sourceUnavailable = true
	if _, err := state.handler().Handle(state.context(), state.job()); err != nil {
		t.Fatal(err)
	}
	if state.sourceReads.Load() != 0 || state.completions.Load() != 1 {
		t.Fatalf("source reads=%d completions=%d", state.sourceReads.Load(), state.completions.Load())
	}
}

func TestRetrySkipsIndividuallyAcknowledgedFileWhenLaterCopyFails(t *testing.T) {
	contents := [][]byte{[]byte("first"), []byte("second")}
	transferIDs := []string{transferID, "30000000-0000-4000-8000-000000000006"}
	ready := map[string]bool{}
	objects := map[string][]byte{}
	sourceReads := [2]int{}
	completeCalls := 0
	failSecond := true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/plan"):
			entries := make([]workerapi.TemplateFileTransfer, 2)
			for index := range entries {
				id := transferIDs[index]
				entry := workerapi.TemplateFileTransfer{
					TransferID: id, SourceItemID: sourceID, TargetItemID: targetID, TargetVersion: index + 1,
					FileName: "file.bin", MediaType: "application/octet-stream", ByteLength: int64(len(contents[index])),
					SHA256: digest(contents[index]), Ready: ready[id],
				}
				if !entry.Ready {
					download, upload, verify := serverCapability(serverURL(r), index)
					entry.DownloadURL, entry.UploadURL, entry.VerifyURL = &download, &upload, &verify
				}
				entries[index] = entry
			}
			writeJSON(w, workerapi.TemplateFileTransferPlan{
				JobID: jobID, OwnerKind: "operation", OwnerID: ownerID, Transfers: entries,
				ObservedAt: time.Now().UTC(), Complete: true,
			})
		case strings.HasSuffix(r.URL.Path, "/complete"):
			var request workerapi.CompleteTemplateFileTransferBatch
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil || len(request.TransferIDs) != 1 {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			ready[request.TransferIDs[0]] = true
			completeCalls++
			writeJSON(w, map[string]any{"jobId": jobID, "completed": true})
		case strings.HasPrefix(r.URL.Path, "/source/"):
			index := int(r.URL.Path[len("/source/")] - '1')
			sourceReads[index]++
			if index == 1 && failSecond {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			_, _ = w.Write(contents[index])
		case strings.HasPrefix(r.URL.Path, "/target/"):
			if r.Method == http.MethodPut {
				if _, exists := objects[r.URL.Path]; exists {
					w.WriteHeader(http.StatusPreconditionFailed)
					return
				}
				objects[r.URL.Path], _ = io.ReadAll(r.Body)
				w.WriteHeader(http.StatusNoContent)
				return
			}
			w.WriteHeader(http.StatusMethodNotAllowed)
		case strings.HasPrefix(r.URL.Path, "/verify/"):
			index := r.URL.Path[len("/verify/")]
			body, exists := objects["/target/"+string(index)]
			if !exists {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = w.Write(body)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	ctx := workerapi.WithExecution(context.Background(), jobID, execution)
	handler := New(workerapi.New(server.URL, "secret", "worker", time.Second), objecttransfer.New(time.Second, server.URL))
	if _, err := handler.Handle(ctx, fixtureJob()); err == nil {
		t.Fatal("first execution succeeded despite the later source failure")
	}
	if !ready[transferIDs[0]] || ready[transferIDs[1]] || completeCalls != 1 || sourceReads[0] != 1 {
		t.Fatalf("after failure ready=%v completeCalls=%d reads=%v", ready, completeCalls, sourceReads)
	}
	failSecond = false
	if _, err := handler.Handle(ctx, fixtureJob()); err != nil {
		t.Fatal(err)
	}
	if !ready[transferIDs[1]] || completeCalls != 2 || sourceReads[0] != 1 || sourceReads[1] != 2 {
		t.Fatalf("after retry ready=%v completeCalls=%d reads=%v", ready, completeCalls, sourceReads)
	}
}

func serverURL(r *http.Request) string { return "http://" + r.Host }

func serverCapability(origin string, index int) (download, upload, verify string) {
	value := strconv.Itoa(index + 1)
	return origin + "/source/" + value, origin + "/target/" + value, origin + "/verify/" + value
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func TestFailedVerificationDoesNotAcknowledgeBatch(t *testing.T) {
	state := newFixture(t, []byte("attachment"), true)
	state.targetBytes = []byte("corruptXXX")
	if _, err := state.handler().Handle(state.context(), state.job()); err == nil {
		t.Fatal("corrupt destination was accepted")
	}
	if state.completions.Load() != 0 {
		t.Fatal("Core was told to mark the transfer ready before verification")
	}
}

func TestLostLeaseFenceRefusesPlan(t *testing.T) {
	state := newFixture(t, []byte("attachment"), false)
	state.planStatus = http.StatusConflict
	_, err := state.handler().Handle(state.context(), state.job())
	var response *workerapi.ResponseError
	if !errors.As(err, &response) || response.Status != http.StatusConflict {
		t.Fatalf("error = %v, want fenced 409", err)
	}
	if state.completions.Load() != 0 {
		t.Fatal("a lost execution acknowledged work")
	}
}

func TestCancellationDuringSourceReadStopsBeforeAcknowledgement(t *testing.T) {
	started := make(chan struct{})
	var completions atomic.Int32
	objects := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/source" {
			close(started)
			<-r.Context().Done()
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer objects.Close()
	core := transferPlanServer(t, objects.URL, &completions)
	defer core.Close()
	ctx, cancel := context.WithCancel(workerapi.WithExecution(context.Background(), jobID, execution))
	done := make(chan error, 1)
	handler := New(workerapi.New(core.URL, "secret", "worker", time.Second), objecttransfer.New(time.Second, objects.URL))
	go func() {
		_, err := handler.Handle(ctx, fixtureJob())
		done <- err
	}()
	<-started
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want cancellation", err)
	}
	if completions.Load() != 0 {
		t.Fatal("cancelled copy acknowledged its batch")
	}
}

type fixture struct {
	apiURL                string
	objectURL             string
	content               []byte
	targetBytes           []byte
	preexisting           bool
	sourceUnavailable     bool
	planStatus            int
	sourceReads           atomic.Int32
	puts                  atomic.Int32
	completions           atomic.Int32
	completeAfterVerified atomic.Bool
	server                *httptest.Server
}

func newFixture(t *testing.T, content []byte, preexisting bool) *fixture {
	t.Helper()
	state := &fixture{content: content, preexisting: preexisting}
	if preexisting {
		state.targetBytes = append([]byte(nil), content...)
	}
	state.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/source" {
			state.sourceReads.Add(1)
			if state.sourceUnavailable {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = w.Write(state.content)
			return
		}
		if r.URL.Path == "/target" {
			state.puts.Add(1)
			if r.Method != http.MethodPut {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			if state.preexisting || r.Header.Get("If-None-Match") != "*" {
				w.WriteHeader(http.StatusPreconditionFailed)
				return
			}
			body, _ := io.ReadAll(r.Body)
			if r.ContentLength != int64(len(state.content)) || r.Header.Get("X-Amz-Checksum-Sha256") == "" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			state.targetBytes = body
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.URL.Path == "/verify" {
			if r.Method != http.MethodGet {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			if state.targetBytes == nil {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = w.Write(state.targetBytes)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/plan") {
			if state.planStatus != 0 {
				w.WriteHeader(state.planStatus)
				return
			}
			writePlan(w, r, state.server.URL+"/source", state.server.URL+"/target", state.server.URL+"/verify", digest(state.content))
			return
		}
		if strings.HasSuffix(r.URL.Path, "/complete") {
			if r.Header.Get("X-Nix-Worker-Job-Id") != jobID || r.Header.Get("X-Nix-Worker-Execution-Id") != execution {
				w.WriteHeader(http.StatusConflict)
				return
			}
			state.completeAfterVerified.Store(string(state.targetBytes) == string(state.content))
			state.completions.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"jobId":"`+jobID+`","completed":true}`)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	state.apiURL, state.objectURL = state.server.URL, state.server.URL
	return state
}

func (state *fixture) handler() *Handler {
	return New(workerapi.New(state.apiURL, "secret", "worker", time.Second), objecttransfer.New(time.Second, state.objectURL))
}

func (state *fixture) context() context.Context {
	return workerapi.WithExecution(context.Background(), jobID, execution)
}

func (state *fixture) job() workerapi.Job { return fixtureJob() }

func fixtureJob() workerapi.Job {
	return workerapi.Job{ID: jobID, Kind: Kind, Payload: json.RawMessage(`{"ownerKind":"operation","ownerId":"` + ownerID + `"}`)}
}

func writePlan(w http.ResponseWriter, r *http.Request, source, upload, verify, sha string) {
	if r.Header.Get("X-Nix-Worker-Job-Id") != jobID || r.Header.Get("X-Nix-Worker-Execution-Id") != execution {
		w.WriteHeader(http.StatusConflict)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"jobId":"`+jobID+`","ownerKind":"operation","ownerId":"`+ownerID+`","transfers":[{"transferId":"`+transferID+`","sourceItemId":"`+sourceID+`","targetItemId":"`+targetID+`","targetVersion":1,"downloadUrl":"`+source+`","uploadUrl":"`+upload+`","verifyUrl":"`+verify+`","fileName":"brief.pdf","mediaType":"application/pdf","byteLength":10,"sha256":"`+sha+`","ready":false}],"observedAt":"2026-09-20T10:00:00Z","nextAfterTransferId":null,"complete":true}`)
}

func digest(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func transferPlanServer(t *testing.T, objects string, completions *atomic.Int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/plan") {
			writePlan(w, r, objects+"/source", objects+"/target", objects+"/verify", digest([]byte("attachment")))
			return
		}
		completions.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"jobId":"`+jobID+`","completed":true}`)
	}))
}
