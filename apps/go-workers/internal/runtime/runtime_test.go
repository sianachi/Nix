package runtime

import (
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/config"
	"github.com/sianachi/Nix/apps/go-workers/internal/role"
)

func TestBrokerWorkersRequireAuthenticatedDependencies(t *testing.T) {
	for _, service := range []role.Service{role.Import, role.Export, role.Index} {
		roles := role.Set{service: true}
		if err := validateSettings(roles, config.Settings{}); err == nil {
			t.Fatalf("%s accepted an empty API URL", service)
		}
		if err := validateSettings(roles, config.Settings{InternalAPIURL: "http://api"}); err == nil {
			t.Fatalf("%s accepted an empty internal secret", service)
		}
		if err := validateSettings(roles, config.Settings{InternalAPIURL: "http://api", InternalSecret: "secret"}); err == nil {
			t.Fatalf("%s accepted an empty broker URL", service)
		}
		valid := config.Settings{InternalAPIURL: "http://api", InternalSecret: "secret", RabbitMQURL: "amqp://rabbit"}
		if service == role.Import {
			valid.CollaborationURL = "http://collab"
		}
		if err := validateSettings(roles, valid); err != nil {
			t.Fatalf("%s rejected valid API configuration: %v", service, err)
		}
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
