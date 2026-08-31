package role

import (
	"fmt"
	"strings"
)

type Service string

const (
	All     Service = "all"
	Import  Service = "import"
	Export  Service = "export"
	Index   Service = "index"
	Plugin  Service = "plugin-events"
	Cleanup Service = "cleanup"
)

type Set map[Service]bool

func Parse(value string) (Set, error) {
	roles := Set{}
	for _, raw := range strings.Split(value, ",") {
		candidate := Service(strings.TrimSpace(raw))
		switch candidate {
		case Import, Export, Index, Plugin, Cleanup:
			roles[candidate] = true
		case "":
			continue
		default:
			return nil, fmt.Errorf("unknown worker role %q", candidate)
		}
	}
	if len(roles) == 0 {
		return nil, fmt.Errorf("at least one worker role is required")
	}
	return roles, nil
}

func (set Set) Has(service Service) bool { return set[service] }
