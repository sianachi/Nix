package pluginruntime

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

const (
	hostModuleName = "nix_host"
	entrypointName = "nix_on_event"
	callOK         = uint32(0)
	callDenied     = uint32(1)
	callInvalid    = uint32(2)
	callFailed     = uint32(3)
	readFailed     = ^uint32(0)
)

var (
	componentNamePattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$`)
	publisherIDPattern   = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]{1,126}[a-z0-9])$`)
	capabilityPattern    = regexp.MustCompile(`^[a-z][a-z0-9.-]{0,63}$`)
	ErrInvalidPlugin     = errors.New("invalid plugin component")
	ErrPluginFailed      = errors.New("plugin execution failed")
)

type Limits struct {
	MaxModuleBytes       int
	MaxEventBytes        int
	MaxHostRequestBytes  int
	MaxHostResponseBytes int
	MaxHostCalls         int
	MemoryLimitPages     uint32
	ExecutionTimeout     time.Duration
}

func DefaultLimits() Limits {
	return Limits{
		MaxModuleBytes:       8 << 20,
		MaxEventBytes:        64 << 10,
		MaxHostRequestBytes:  64 << 10,
		MaxHostResponseBytes: 256 << 10,
		MaxHostCalls:         32,
		MemoryLimitPages:     1024,
		ExecutionTimeout:     250 * time.Millisecond,
	}
}

type Component struct {
	ID        string
	Version   string
	SHA256    string
	PublicKey []byte
	Signature []byte
	Wasm      []byte
}

type Invocation struct {
	InstallationID string
	EventID        string
	Component      Component
	Event          json.RawMessage
	Capabilities   []string
}

type Host interface {
	Call(context.Context, string, string, string, json.RawMessage) (json.RawMessage, error)
}

type Runtime struct {
	limits Limits
}

func New(limits Limits) (*Runtime, error) {
	if limits.MaxModuleBytes <= 0 || limits.MaxModuleBytes > 32<<20 ||
		limits.MaxEventBytes <= 0 || limits.MaxEventBytes > 1<<20 ||
		limits.MaxHostRequestBytes <= 0 || limits.MaxHostRequestBytes > 1<<20 ||
		limits.MaxHostResponseBytes <= 0 || limits.MaxHostResponseBytes > 4<<20 ||
		limits.MaxHostCalls <= 0 || limits.MaxHostCalls > 256 ||
		limits.MemoryLimitPages == 0 || limits.MemoryLimitPages > 4096 ||
		limits.ExecutionTimeout <= 0 || limits.ExecutionTimeout > 5*time.Second {
		return nil, errors.New("plugin runtime limits are invalid")
	}
	return &Runtime{limits: limits}, nil
}

func (runtime *Runtime) Execute(ctx context.Context, invocation Invocation, host Host) error {
	if runtime == nil || host == nil {
		return ErrInvalidPlugin
	}
	if err := runtime.validate(invocation); err != nil {
		return err
	}

	executionContext, cancel := context.WithTimeout(ctx, runtime.limits.ExecutionTimeout)
	defer cancel()
	configuration := wazero.NewRuntimeConfigInterpreter().
		WithMemoryLimitPages(runtime.limits.MemoryLimitPages).
		WithDebugInfoEnabled(false).
		WithCloseOnContextDone(true)
	wasmRuntime := wazero.NewRuntimeWithConfig(executionContext, configuration)
	defer func() { _ = wasmRuntime.Close(context.Background()) }()

	state := newHostState(invocation, host, runtime.limits)
	_, err := wasmRuntime.NewHostModuleBuilder(hostModuleName).
		NewFunctionBuilder().WithFunc(state.eventSize).Export("event_size").
		NewFunctionBuilder().WithFunc(state.eventRead).Export("event_read").
		NewFunctionBuilder().WithFunc(state.hostCall).Export("call").
		NewFunctionBuilder().WithFunc(state.responseSize).Export("response_size").
		NewFunctionBuilder().WithFunc(state.responseRead).Export("response_read").
		Instantiate(executionContext)
	if err != nil {
		return fmt.Errorf("%w: instantiate bounded host ABI: %v", ErrPluginFailed, err)
	}

	compiled, err := wasmRuntime.CompileModule(executionContext, invocation.Component.Wasm)
	if err != nil {
		return fmt.Errorf("%w: compile component: %v", ErrInvalidPlugin, err)
	}
	defer func() { _ = compiled.Close(context.Background()) }()
	module, err := wasmRuntime.InstantiateModule(
		executionContext,
		compiled,
		wazero.NewModuleConfig().WithName("").WithStartFunctions())
	if err != nil {
		return fmt.Errorf("%w: instantiate component: %v", ErrInvalidPlugin, err)
	}
	defer func() { _ = module.Close(context.Background()) }()

	entrypoint := module.ExportedFunction(entrypointName)
	if entrypoint == nil {
		return fmt.Errorf("%w: %s export is required", ErrInvalidPlugin, entrypointName)
	}
	results, err := entrypoint.Call(executionContext)
	if err != nil {
		if executionContext.Err() != nil {
			return fmt.Errorf("%w: execution limit reached: %v", ErrPluginFailed, executionContext.Err())
		}
		return fmt.Errorf("%w: guest trapped: %v", ErrPluginFailed, err)
	}
	if len(results) != 1 || uint32(results[0]) != 0 {
		if state.hostError != nil {
			return errors.Join(ErrPluginFailed, fmt.Errorf("plugin host call failed: %w", state.hostError))
		}
		return fmt.Errorf("%w: guest returned a non-zero status", ErrPluginFailed)
	}
	return nil
}

func (runtime *Runtime) validate(invocation Invocation) error {
	component := invocation.Component
	if !validComponentID(component.ID) || !validSemanticVersion(component.Version) ||
		len(component.Wasm) == 0 || len(component.Wasm) > runtime.limits.MaxModuleBytes ||
		len(component.PublicKey) != ed25519.PublicKeySize || len(component.Signature) != ed25519.SignatureSize ||
		len(invocation.Event) == 0 || len(invocation.Event) > runtime.limits.MaxEventBytes || !json.Valid(invocation.Event) ||
		!validateCanonicalID(invocation.InstallationID) || !validateCanonicalID(invocation.EventID) || len(invocation.Capabilities) > 32 {
		return ErrInvalidPlugin
	}
	digest := sha256.Sum256(component.Wasm)
	if component.SHA256 != strings.ToUpper(hex.EncodeToString(digest[:])) {
		return fmt.Errorf("%w: component digest mismatch", ErrInvalidPlugin)
	}
	if !ed25519.Verify(component.PublicKey, signaturePayload(component), component.Signature) {
		return fmt.Errorf("%w: component signature mismatch", ErrInvalidPlugin)
	}
	capabilities := slices.Clone(invocation.Capabilities)
	slices.Sort(capabilities)
	for index, capability := range capabilities {
		if !capabilityPattern.MatchString(capability) || index > 0 && capability == capabilities[index-1] {
			return ErrInvalidPlugin
		}
	}
	return nil
}

func signaturePayload(component Component) []byte {
	return []byte("nix-plugin-component-v1\n" + component.ID + "\n" + component.Version + "\n" + component.SHA256)
}

func validComponentID(value string) bool {
	publisher, name, found := strings.Cut(value, "/")
	return found && !strings.Contains(name, "/") && strings.Contains(publisher, ".") &&
		publisherIDPattern.MatchString(publisher) && componentNamePattern.MatchString(name)
}

func validSemanticVersion(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	withoutBuild, build, hasBuild := strings.Cut(value, "+")
	if hasBuild && !validVersionIdentifiers(build, false) || strings.Contains(build, "+") {
		return false
	}
	core, prerelease, hasPrerelease := strings.Cut(withoutBuild, "-")
	if hasPrerelease && !validVersionIdentifiers(prerelease, true) {
		return false
	}
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if part == "" || len(part) > 1 && part[0] == '0' {
			return false
		}
		if _, err := strconv.ParseUint(part, 10, 64); err != nil {
			return false
		}
	}
	return true
}

func validVersionIdentifiers(value string, numericLeadingZeroForbidden bool) bool {
	if value == "" {
		return false
	}
	for _, identifier := range strings.Split(value, ".") {
		if identifier == "" {
			return false
		}
		numeric := true
		for _, character := range identifier {
			if character < '0' || character > '9' {
				numeric = false
			}
			if character != '-' && (character < '0' || character > '9') && (character < 'A' || character > 'Z') && (character < 'a' || character > 'z') {
				return false
			}
		}
		if numericLeadingZeroForbidden && numeric && len(identifier) > 1 && identifier[0] == '0' {
			return false
		}
	}
	return true
}

type hostState struct {
	invocation Invocation
	host       Host
	limits     Limits
	granted    map[string]struct{}
	response   []byte
	calls      int
	hostError  error
}

func newHostState(invocation Invocation, host Host, limits Limits) *hostState {
	granted := make(map[string]struct{}, len(invocation.Capabilities))
	for _, capability := range invocation.Capabilities {
		granted[capability] = struct{}{}
	}
	return &hostState{invocation: invocation, host: host, limits: limits, granted: granted}
}

func (state *hostState) eventSize() uint32 { return uint32(len(state.invocation.Event)) }

func (state *hostState) eventRead(_ context.Context, module api.Module, offset uint32) uint32 {
	memory := module.Memory()
	if memory == nil || !memory.Write(offset, state.invocation.Event) {
		return readFailed
	}
	return uint32(len(state.invocation.Event))
}

func (state *hostState) hostCall(ctx context.Context, module api.Module, capabilityOffset, capabilityLength, requestOffset, requestLength uint32) uint32 {
	state.response = nil
	state.calls++
	if state.calls > state.limits.MaxHostCalls || capabilityLength == 0 || int(capabilityLength) > 64 || requestLength == 0 || int(requestLength) > state.limits.MaxHostRequestBytes {
		return callInvalid
	}
	memory := module.Memory()
	if memory == nil {
		return callInvalid
	}
	capabilityBytes, ok := memory.Read(capabilityOffset, capabilityLength)
	if !ok {
		return callInvalid
	}
	capability := string(capabilityBytes)
	if !capabilityPattern.MatchString(capability) {
		return callInvalid
	}
	if _, allowed := state.granted[capability]; !allowed {
		return callDenied
	}
	requestBytes, ok := memory.Read(requestOffset, requestLength)
	if !ok || !json.Valid(requestBytes) {
		return callInvalid
	}
	request := append(json.RawMessage(nil), requestBytes...)
	response, err := state.host.Call(ctx, state.invocation.InstallationID, state.invocation.EventID, capability, request)
	if err != nil || len(response) > state.limits.MaxHostResponseBytes || !json.Valid(response) {
		state.hostError = err
		return callFailed
	}
	state.response = append(state.response[:0], response...)
	return callOK
}

func (state *hostState) responseSize() uint32 { return uint32(len(state.response)) }

func (state *hostState) responseRead(_ context.Context, module api.Module, offset uint32) uint32 {
	if len(state.response) == 0 || module.Memory() == nil || !module.Memory().Write(offset, state.response) {
		return readFailed
	}
	return uint32(len(state.response))
}

func validateCanonicalID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for position, character := range value {
		if position == 8 || position == 13 || position == 18 || position == 23 {
			continue
		}
		if character < '0' || character > '9' && character < 'a' || character > 'f' {
			return false
		}
	}
	return value != "00000000-0000-0000-0000-000000000000"
}
