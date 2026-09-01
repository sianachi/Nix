package runtime

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/sianachi/Nix/apps/go-workers/internal/config"
	"github.com/sianachi/Nix/apps/go-workers/internal/role"
)

func TestBrokerWorkersRequireAuthenticatedDependencies(t *testing.T) {
	for _, service := range []role.Service{role.Import, role.Export, role.Index} {
		roles := role.Set{service: true}
		if err := validateSettings(roles, config.Settings{}); err == nil {
			t.Fatalf("%s accepted an empty internal credential", service)
		}
		if err := validateSettings(roles, config.Settings{InternalAPIURL: "http://api", RabbitMQURL: "amqp://rabbit"}); err == nil {
			t.Fatalf("%s accepted an empty internal secret", service)
		}
		if err := validateSettings(roles, config.Settings{InternalAPIURL: "http://api", InternalSecret: "secret"}); err == nil {
			t.Fatalf("%s accepted an empty broker URL", service)
		}
		valid := config.Settings{InternalAPIURL: "http://api", InternalSecret: "secret", RabbitMQURL: "amqp://rabbit"}
		if service == role.Import || service == role.Export {
			valid.CollaborationURL = "http://collab"
			valid.ObjectOrigins = []string{"https://objects.example.test"}
		}
		if service == role.Index {
			valid.OpenSearchURL = "http://opensearch"
			valid.OpenSearchIndex = "nix-items"
		}
		if err := validateSettings(roles, valid); err != nil {
			t.Fatalf("%s rejected valid API configuration: %v", service, err)
		}
		withoutAPI := valid
		withoutAPI.InternalAPIURL = ""
		if err := validateSettings(roles, withoutAPI); err == nil {
			t.Fatalf("%s accepted a missing worker API URL", service)
		}
	}
}

func TestIndexWorkerRejectsMissingOrBroadOpenSearchTargets(t *testing.T) {
	settings := config.Settings{
		InternalAPIURL:  "http://api",
		InternalSecret:  "secret",
		RabbitMQURL:     "amqp://rabbit",
		OpenSearchURL:   "http://opensearch",
		OpenSearchIndex: "nix-items",
	}
	roles := role.Set{role.Index: true}

	missingURL := settings
	missingURL.OpenSearchURL = ""
	if err := validateSettings(roles, missingURL); err == nil {
		t.Fatal("index worker accepted a missing OpenSearch URL")
	}
	broadIndex := settings
	broadIndex.OpenSearchIndex = "nix-*"
	if err := validateSettings(roles, broadIndex); err == nil {
		t.Fatal("index worker accepted a wildcard OpenSearch index")
	}
}

func TestServiceProbeRequiresAHealthyNonRedirectingDependency(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/healthz":
			response.WriteHeader(http.StatusNoContent)
		case "/redirect/healthz":
			http.Redirect(response, request, "/healthz", http.StatusTemporaryRedirect)
		default:
			response.WriteHeader(http.StatusServiceUnavailable)
		}
	}))
	defer server.Close()

	if err := newServiceProbe(server.URL, time.Second).Ping(context.Background()); err != nil {
		t.Fatalf("healthy dependency was refused: %v", err)
	}
	if err := newServiceProbe(server.URL+"/redirect", time.Second).Ping(context.Background()); err == nil {
		t.Fatal("redirecting dependency was accepted")
	}
	if err := newServiceProbe(server.URL+"/missing", time.Second).Ping(context.Background()); err == nil {
		t.Fatal("unhealthy dependency was accepted")
	}
}

func TestObjectStoreProbeAcceptsPrivateRefusalButRejectsRedirectAndOutage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/private/":
			response.WriteHeader(http.StatusForbidden)
		case "/redirect/":
			http.Redirect(response, request, "/private/", http.StatusTemporaryRedirect)
		default:
			response.WriteHeader(http.StatusServiceUnavailable)
		}
	}))
	defer server.Close()

	if err := newObjectStoreProbe([]string{server.URL + "/private"}, time.Second).Ping(context.Background()); err != nil {
		t.Fatalf("reachable private object storage was refused: %v", err)
	}
	if err := newObjectStoreProbe([]string{server.URL + "/redirect"}, time.Second).Ping(context.Background()); err == nil {
		t.Fatal("redirecting object storage was accepted")
	}
	if err := newObjectStoreProbe([]string{server.URL + "/outage"}, time.Second).Ping(context.Background()); err == nil {
		t.Fatal("unavailable object storage was accepted")
	}
	if err := newObjectStoreProbe(nil, time.Second).Ping(context.Background()); err == nil {
		t.Fatal("an empty object-storage origin set was accepted")
	}
}

func TestCombinedWorkerParsesConfiguredRoles(t *testing.T) {
	roles, err := selectedRoles(role.All, "import,export,index")
	if err != nil {
		t.Fatal(err)
	}
	if !roles.Has(role.Import) || !roles.Has(role.Export) || !roles.Has(role.Index) {
		t.Fatalf("configured roles were not preserved: %#v", roles)
	}
}

func TestHealthURLAcceptsWildcardAndExplicitAddresses(t *testing.T) {
	for address, expected := range map[string]string{
		":8301":          "http://127.0.0.1:8301/healthz",
		"127.0.0.1:8302": "http://127.0.0.1:8302/healthz",
	} {
		if actual := healthURL(address); actual != expected {
			t.Fatalf("health URL for %q = %q, want %q", address, actual, expected)
		}
	}
}
