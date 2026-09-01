package importplan

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode/utf8"
)

const TemplatePlanVersion = 1

var (
	templateKeyPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]{0,158}[a-z0-9])?$`)
	sha256Pattern      = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// TemplateProfile is the additive profile carried by a reusable .nix archive.
type TemplateProfile struct {
	Kind            string `json:"kind"`
	Version         int    `json:"version"`
	Key             string `json:"key"`
	Name            string `json:"name"`
	Description     string `json:"description"`
	IncludeBody     bool   `json:"includeBody"`
	IncludeChildren bool   `json:"includeChildren"`
}

func (profile *TemplateProfile) UnmarshalJSON(body []byte) error {
	var value struct {
		Kind            *string `json:"kind"`
		Version         *int    `json:"version"`
		Key             *string `json:"key"`
		Name            *string `json:"name"`
		Description     *string `json:"description"`
		IncludeBody     *bool   `json:"includeBody"`
		IncludeChildren *bool   `json:"includeChildren"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("template profile contains multiple JSON values")
		}
		return err
	}
	if value.Kind == nil || value.Version == nil || value.Key == nil || value.Name == nil || value.Description == nil || value.IncludeBody == nil || value.IncludeChildren == nil {
		return errors.New("the template profile is incomplete")
	}
	*profile = TemplateProfile{
		Kind: *value.Kind, Version: *value.Version, Key: *value.Key, Name: *value.Name,
		Description: *value.Description, IncludeBody: *value.IncludeBody, IncludeChildren: *value.IncludeChildren,
	}
	return nil
}

// TemplatePlan is the bounded, deterministic handoff between preview and commit.
type TemplatePlan struct {
	Version      int             `json:"version"`
	SourceSHA256 string          `json:"sourceSha256"`
	Profile      TemplateProfile `json:"profile"`
	RootItemType string          `json:"rootItemType"`
	ItemCount    int             `json:"itemCount"`
	BodyCount    int             `json:"bodyCount"`
	ViewCount    int             `json:"viewCount"`
	Items        []TemplateItem  `json:"items"`
}

// TemplateItem preserves the archive's portable identity, parentage, signed sequence, and body.
type TemplateItem struct {
	SourceID       string          `json:"sourceId"`
	ParentSourceID *string         `json:"parentSourceId"`
	Sequence       string          `json:"seq"`
	Title          string          `json:"title"`
	ItemType       string          `json:"itemType"`
	Properties     json.RawMessage `json:"properties"`
	Schema         json.RawMessage `json:"schema"`
	Views          json.RawMessage `json:"views"`
	Body           json.RawMessage `json:"body"`
}

// ParseTemplate validates a template-profile .nix archive through the same bounded archive reader
// used by ordinary imports, then normalizes only the data required for durable staging.
func ParseTemplate(ctx context.Context, source Source, limits Limits) (TemplatePlan, error) {
	if err := validateSource(source, limits); err != nil {
		return TemplatePlan{}, err
	}
	if normalizeFormat(source.Format) != "nix" {
		return TemplatePlan{}, fmt.Errorf("%w: %s", ErrUnsupportedFormat, source.Format)
	}
	parsed, err := validateNixArchive(ctx, source, limits)
	if err != nil {
		return TemplatePlan{}, err
	}
	if len(parsed.manifest.Omitted) != 0 || len(parsed.manifest.Loss) != 0 {
		return TemplatePlan{}, errors.New("a template archive cannot contain omissions or loss")
	}
	var profile TemplateProfile
	if isJSONNull(parsed.manifest.Profile) {
		return TemplatePlan{}, errors.New("the Nix archive does not contain a template profile")
	}
	if err := decodeStrictJSON(parsed.manifest.Profile, &profile); err != nil {
		return TemplatePlan{}, fmt.Errorf("decode template profile: %w", err)
	}
	if err := validateTemplateProfile(profile); err != nil {
		return TemplatePlan{}, err
	}
	if !profile.IncludeChildren && len(parsed.items) != 1 {
		return TemplatePlan{}, errors.New("the template profile excludes children but the archive contains descendants")
	}

	plan := TemplatePlan{
		Version: TemplatePlanVersion, SourceSHA256: strings.ToLower(source.SHA256), Profile: profile,
		ItemCount: len(parsed.items), Items: make([]TemplateItem, 0, len(parsed.items)),
	}
	for _, parsedItem := range parsed.items {
		if err := ctx.Err(); err != nil {
			return TemplatePlan{}, err
		}
		entry := parsedItem.manifest
		bundle := parsedItem.bundle
		views := cloneNullableJSON(bundle.Views)
		viewCount, err := countTemplateViews(views)
		if err != nil {
			return TemplatePlan{}, fmt.Errorf("Nix item %s: %w", entry.ID, err)
		}
		plan.ViewCount += viewCount
		body := cloneNullableJSON(bundle.Body)
		if body != nil {
			plan.BodyCount++
		}
		if entry.ID == parsed.manifest.Root {
			plan.RootItemType = bundle.Type
			if !profile.IncludeBody && body != nil {
				return TemplatePlan{}, errors.New("the template profile excludes the root body but the archive contains it")
			}
		}
		plan.Items = append(plan.Items, TemplateItem{
			SourceID: entry.ID, ParentSourceID: cloneOptionalString(entry.ParentID), Sequence: entry.Sequence,
			Title: bundle.Title, ItemType: bundle.Type, Properties: cloneJSON(bundle.Properties),
			Schema: importNixSchema(entry.ID == parsed.manifest.Root, parsed.manifest.RootEffectiveSchema, bundle.Schema),
			Views:  views, Body: body,
		})
	}
	if err := validateTemplatePlan(plan, &limits); err != nil {
		return TemplatePlan{}, err
	}
	return plan, nil
}

// EncodeTemplate returns stable JSON and its lowercase SHA-256 digest.
func EncodeTemplate(plan TemplatePlan, maxBytes int64) ([]byte, string, error) {
	if maxBytes <= 0 {
		return nil, "", errors.New("template plan byte limit must be positive")
	}
	if err := validateTemplatePlan(plan, nil); err != nil {
		return nil, "", err
	}
	body, err := json.Marshal(plan)
	if err != nil {
		return nil, "", err
	}
	if int64(len(body)) > maxBytes {
		return nil, "", errors.New("template plan exceeds the configured byte limit")
	}
	digest := sha256.Sum256(body)
	return body, hex.EncodeToString(digest[:]), nil
}

// DecodeTemplate verifies the preview digest and validates the persisted plan before commit.
func DecodeTemplate(body []byte, expectedDigest string, limits Limits) (TemplatePlan, error) {
	if int64(len(body)) > limits.MaxPlanBytes {
		return TemplatePlan{}, errors.New("template plan exceeds the configured byte limit")
	}
	digest := sha256.Sum256(body)
	if !strings.EqualFold(hex.EncodeToString(digest[:]), expectedDigest) {
		return TemplatePlan{}, errors.New("template plan checksum does not match the preview")
	}
	if err := validateJSONDepth(body, limits.MaxDepth+8); err != nil {
		return TemplatePlan{}, fmt.Errorf("template plan JSON: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var plan TemplatePlan
	if err := decoder.Decode(&plan); err != nil {
		return TemplatePlan{}, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return TemplatePlan{}, errors.New("template plan contains multiple JSON values")
		}
		return TemplatePlan{}, err
	}
	if err := validateTemplatePlan(plan, &limits); err != nil {
		return TemplatePlan{}, err
	}
	return plan, nil
}

func validateTemplateProfile(profile TemplateProfile) error {
	if profile.Kind != "template" || profile.Version != 1 {
		return errors.New("the template profile kind or version is unsupported")
	}
	if !templateKeyPattern.MatchString(profile.Key) || !boundedText(profile.Name, 200, false) || !boundedText(profile.Description, 1000, true) {
		return errors.New("the template profile key, name, or description is invalid")
	}
	return nil
}

func validateTemplatePlan(plan TemplatePlan, limits *Limits) error {
	if plan.Version != TemplatePlanVersion || !sha256Pattern.MatchString(plan.SourceSHA256) || validateTemplateProfile(plan.Profile) != nil || len(plan.Items) == 0 {
		return errors.New("template plan metadata is invalid")
	}
	if limits != nil && (len(plan.Items) > limits.MaxItems || limits.MaxDepth <= 0 || limits.MaxBodyBytes <= 0) {
		return errors.New("template plan exceeds the configured limits")
	}
	seen := make(map[string]struct{}, len(plan.Items))
	depths := make(map[string]int, len(plan.Items))
	rootCount, bodyCount, viewCount := 0, 0, 0
	rootType := ""
	rootHasBody := false
	for _, item := range plan.Items {
		if !validArchiveID(item.SourceID) || !validIntegerString(item.Sequence) || !boundedText(item.Title, 500, true) || !boundedText(item.ItemType, 64, false) || !isJSONObject(item.Properties) {
			return errors.New("template plan contains an invalid item envelope")
		}
		if _, duplicate := seen[item.SourceID]; duplicate {
			return errors.New("template plan contains a duplicate source item")
		}
		depth := 0
		if item.ParentSourceID == nil {
			rootCount++
			rootType = item.ItemType
			rootHasBody = !isJSONNull(item.Body)
		} else {
			if !validArchiveID(*item.ParentSourceID) {
				return errors.New("template plan contains an invalid parent source item")
			}
			if _, parentSeen := seen[*item.ParentSourceID]; !parentSeen {
				return errors.New("template plan items are not parent-first")
			}
			depth = depths[*item.ParentSourceID] + 1
		}
		if limits != nil && depth > limits.MaxDepth {
			return errors.New("template plan tree is too deep")
		}
		depths[item.SourceID] = depth
		seen[item.SourceID] = struct{}{}
		if limits != nil {
			for name, value := range map[string]json.RawMessage{
				"properties": item.Properties,
				"schema":     item.Schema,
				"views":      item.Views,
				"body":       item.Body,
			} {
				if err := validateJSONDepth(value, limits.MaxDepth); err != nil {
					return fmt.Errorf("template plan item %s %s: %w", item.SourceID, name, err)
				}
			}
		}
		if !isJSONNull(item.Schema) && !isJSONObject(item.Schema) {
			return errors.New("template plan contains an invalid property schema")
		}
		if !isJSONNull(item.Views) && !isJSONObject(item.Views) {
			return errors.New("template plan contains invalid views")
		}
		if !isJSONNull(item.Body) {
			if !isJSONObject(item.Body) || limits != nil && int64(len(item.Body)) > limits.MaxBodyBytes {
				return errors.New("template plan contains an invalid or oversized body")
			}
			bodyCount++
		}
		count, err := countTemplateViews(item.Views)
		if err != nil {
			return err
		}
		viewCount += count
	}
	if rootCount != 1 || rootType != plan.RootItemType || plan.ItemCount != len(plan.Items) || plan.BodyCount != bodyCount || plan.ViewCount != viewCount {
		return errors.New("template plan counts or root metadata are inconsistent")
	}
	if !plan.Profile.IncludeChildren && len(plan.Items) != 1 {
		return errors.New("template plan descendants disagree with its profile")
	}
	if !plan.Profile.IncludeBody && rootHasBody {
		return errors.New("template plan root body disagrees with its profile")
	}
	return nil
}

// validateJSONDepth bounds attacker-controlled nesting without materializing another decoded tree.
// The strict decoders remain responsible for complete JSON syntax validation.
func validateJSONDepth(body []byte, maximum int) error {
	if maximum <= 0 {
		return errors.New("JSON depth limit must be positive")
	}
	depth := 0
	inString := false
	escaped := false
	for _, value := range body {
		if inString {
			if escaped {
				escaped = false
				continue
			}
			switch value {
			case '\\':
				escaped = true
			case '"':
				inString = false
			}
			continue
		}
		switch value {
		case '"':
			inString = true
		case '{', '[':
			depth++
			if depth > maximum {
				return errors.New("JSON nesting exceeds the configured depth limit")
			}
		case '}', ']':
			depth--
			if depth < 0 {
				return errors.New("JSON nesting is malformed")
			}
		}
	}
	if inString || depth != 0 {
		return errors.New("JSON nesting is malformed")
	}
	return nil
}

func countTemplateViews(value json.RawMessage) (int, error) {
	if isJSONNull(value) {
		return 0, nil
	}
	var snapshot struct {
		Views   []json.RawMessage `json:"views"`
		Default string            `json:"default"`
	}
	if err := decodeStrictJSON(value, &snapshot); err != nil || snapshot.Views == nil {
		return 0, errors.New("template item views are invalid")
	}
	return len(snapshot.Views), nil
}

func boundedText(value string, maximum int, allowEmpty bool) bool {
	return utf8.ValidString(value) && utf8.RuneCountInString(value) <= maximum && (allowEmpty || strings.TrimSpace(value) != "")
}

func cloneOptionalString(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
