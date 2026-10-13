package companion

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
)

const providerErrorHeader = "X-Nix-Provider-Error"

type providerFailure struct {
	provider string
	status   int
	code     string
}

func (e *providerFailure) token() string {
	if e.code == "" {
		return ""
	}
	return e.provider + "." + e.code + "." + strconv.Itoa(e.status)
}

func (e *providerFailure) Error() string {
	if message := providerFailureMessage(e.provider, e.token()); message != "" {
		return fmt.Sprintf("%s (HTTP %d)", message, e.status)
	}
	return fmt.Sprintf("%s answered HTTP %d", e.provider, e.status)
}

func providerFailureToken(err error) string {
	var failure *providerFailure
	if errors.As(err, &failure) {
		return failure.token()
	}
	return ""
}

func writeProviderFailure(w http.ResponseWriter, err error) {
	if token := providerFailureToken(err); token != "" {
		w.Header().Set(providerErrorHeader, token)
	}
	http.Error(w, "Companion request failed; reconnect or retry", http.StatusBadGateway)
}

// Only fixed messages cross the provider boundary; error text is used for classification only.
func providerResponseError(provider string, response *http.Response, models bool) error {
	failure := &providerFailure{provider: provider, status: response.StatusCode}
	switch response.StatusCode {
	case http.StatusUnauthorized:
		failure.code = "authentication"
	case http.StatusForbidden:
		failure.code = "permission"
	case http.StatusPaymentRequired:
		failure.code = "credit_balance"
	case http.StatusTooManyRequests:
		failure.code = "rate_limited"
	case http.StatusBadRequest:
		if provider != "anthropic" {
			break
		}
		var envelope struct {
			Error struct {
				Type    string `json:"type"`
				Message string `json:"message"`
			} `json:"error"`
		}
		decoder := json.NewDecoder(&boundedReader{r: response.Body, limit: 4 << 10})
		var extra any
		if decoder.Decode(&envelope) != nil || decoder.Decode(&extra) != io.EOF || envelope.Error.Type != "invalid_request_error" || envelope.Error.Message == "" {
			break
		}
		message := strings.ToLower(envelope.Error.Message)
		if strings.Contains(message, "credit balance") && (strings.Contains(message, "too low") || strings.Contains(message, "insufficient")) {
			failure.code = "credit_balance"
		} else if models {
			failure.code = "models_rejected"
		}
	}
	return failure
}

func providerFailureMessage(provider, token string) string {
	if provider != "anthropic" && provider != "openrouter" || !strings.HasPrefix(token, provider+".") {
		return ""
	}
	name := "OpenRouter"
	if provider == "anthropic" {
		name = "Claude"
	}
	switch strings.TrimPrefix(token, provider+".") {
	case "credit_balance.400":
		if provider != "anthropic" {
			return ""
		}
		fallthrough
	case "credit_balance.402":
		return name + " reports that this API key has insufficient credit. Check API billing for the key, then try again."
	case "authentication.401":
		return name + " rejected the API key. Update it in Settings > Pets."
	case "permission.403":
		return name + " refused access for this API key. Check the key's permissions and API access."
	case "rate_limited.429":
		return name + " is rate limiting this API key. Wait briefly, then try again."
	case "models_rejected.400":
		if provider == "anthropic" {
			return name + " rejected model discovery for this API key. Check its API access and billing, then try again."
		}
	}
	return ""
}
