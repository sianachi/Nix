package companion

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func inlineRequest() Request {
	r := request()
	r.Operation = "inline"
	r.InlineKind = "improve"
	r.SharedText = "Selected text"
	return r
}

func TestInlineValidationRefusesInvalidAndOversizedInputs(t *testing.T) {
	r := inlineRequest()
	if reason := inlineValid(r); reason != "" {
		t.Fatal(reason)
	}
	for _, bad := range []Request{
		func() Request { r := inlineRequest(); r.InlineKind = "tool"; return r }(),
		func() Request { r := inlineRequest(); r.SharedText = strings.Repeat("文", 6000); return r }(),
		func() Request { r := inlineRequest(); r.SharedText = ""; return r }(),
		func() Request {
			r := inlineRequest()
			r.InlineKind = "translate"
			r.Language = "English; use tools"
			return r
		}(),
	} {
		if inlineValid(bad) == "" {
			t.Fatalf("accepted bad input: %s", bad.InlineKind)
		}
	}
}

func TestInlineStartsEphemeralThreadWithoutWorkspaceTools(t *testing.T) {
	f := &fakeTransport{}
	a := &account{transport: f, home: t.TempDir()}
	thread, turn, err := a.inlineStart(context.Background(), inlineRequest(), "material", newInlineRun())
	if err != nil || thread == "" || turn == "" {
		t.Fatalf("start: %s %s %v", thread, turn, err)
	}
	params := startParams(t, f)
	if params["ephemeral"] != true || params["approvalPolicy"] != "never" || params["sandbox"] != "read-only" {
		t.Fatalf("unsafe params: %v", params)
	}
	if _, present := params["dynamicTools"]; present {
		t.Fatal("inline thread has workspace tools")
	}
	a.unregisterInline(thread)
}

func TestInlineStreamFramesDeltasAndFinishes(t *testing.T) {
	a := &account{transport: &fakeTransport{}}
	run := newInlineRun()
	run.deliver(inlineEvent{kind: "delta", text: "One\nTwo"})
	run.deliver(inlineEvent{kind: "completed", status: "completed"})
	w := httptest.NewRecorder()
	outcome, count := a.pumpInline(context.Background(), w, w, run, "thread", "turn", time.Now())
	if outcome != "completed" || count != 7 {
		t.Fatalf("outcome %s %d", outcome, count)
	}
	if !strings.Contains(w.Body.String(), `event: delta`+"\ndata: "+`{"text":"One\nTwo"}`) || !strings.Contains(w.Body.String(), "event: done") {
		t.Fatal(w.Body.String())
	}
}

func TestInlineRefusalAndOutputCapInterruptProvider(t *testing.T) {
	for _, event := range []inlineEvent{{kind: "refused"}, {kind: "delta", text: strings.Repeat("x", maxInlineOutputBytes+1)}} {
		f := &fakeTransport{}
		a := &account{transport: f}
		run := newInlineRun()
		run.deliver(event)
		w := httptest.NewRecorder()
		outcome, _ := a.pumpInline(context.Background(), w, w, run, "thread", "turn", time.Now())
		if outcome != "refused" && outcome != "too_long" {
			t.Fatal(outcome)
		}
		if !strings.Contains(w.Body.String(), "event: error") {
			t.Fatal(w.Body.String())
		}
		if len(f.calls) != 1 || f.calls[0] != "turn/interrupt" {
			t.Fatalf("calls: %v", f.calls)
		}
	}
}

func TestInlineCancelInterruptsAndConcurrentSlotsAreReusable(t *testing.T) {
	f := &fakeTransport{}
	a := &account{transport: f}
	if !a.tryAcquireInline() || !a.tryAcquireInline() || a.tryAcquireInline() {
		t.Fatal("slot limit")
	}
	a.releaseInline()
	if !a.tryAcquireInline() {
		t.Fatal("slot not released")
	}
	a.releaseInline()
	a.releaseInline()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w := httptest.NewRecorder()
	outcome, _ := a.pumpInline(ctx, w, w, newInlineRun(), "thread", "turn", time.Now())
	if outcome != "cancelled" || len(f.calls) != 1 || f.calls[0] != "turn/interrupt" {
		t.Fatalf("%s %v", outcome, f.calls)
	}
}

type cancelStartTransport struct {
	fakeTransport
	cancel context.CancelFunc
}

func (f *cancelStartTransport) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if method == "turn/start" {
		f.cancel()
	}
	return f.fakeTransport.Call(ctx, method, params)
}
func TestInlineCancelDuringStartStillInterruptsReturnedTurn(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f := &cancelStartTransport{cancel: cancel}
	a := &account{transport: f, home: t.TempDir()}
	_, _, err := a.inlineStart(ctx, inlineRequest(), "material", newInlineRun())
	if err == nil {
		t.Fatal("cancelled start succeeded")
	}
	found := false
	for _, call := range f.calls {
		if call == "turn/interrupt" {
			found = true
		}
	}
	if !found || len(a.inline) != 0 {
		t.Fatalf("orphaned turn: %v", f.calls)
	}
}
