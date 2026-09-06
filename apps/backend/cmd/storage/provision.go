package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/google/uuid"
	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
)

const (
	defaultS3ProvisionOrigin      = "https://duallane.tsio.top"
	defaultS3ProvisionRegion      = "us-east-1"
	s3ProvisionMultipartAbortDays = 7
	maxS3ProvisionPolicyBytes     = 1 << 20
	s3ProvisionCleanupTimeout     = 5 * time.Second
	s3ProvisionCanaryMaxUploads   = 1
	s3ProvisionBucketNameMaxBytes = 63
	s3ProvisionRegionMaxBytes     = 128
)

var s3ProvisionBucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)

type s3ProvisionConfig struct {
	Endpoint  string
	Region    string
	Bucket    string
	AccessKey string
	SecretKey string
	AppOrigin string
}

// s3ProvisionAPI is intentionally limited to the bucket-control and
// multipart operations required by the Node provisioning contract. It does
// not expose object reads/writes or a generic provider client to the command.
type s3ProvisionAPI interface {
	HeadBucket(context.Context, *s3.HeadBucketInput, ...func(*s3.Options)) (*s3.HeadBucketOutput, error)
	GetBucketPolicy(context.Context, *s3.GetBucketPolicyInput, ...func(*s3.Options)) (*s3.GetBucketPolicyOutput, error)
	PutBucketVersioning(context.Context, *s3.PutBucketVersioningInput, ...func(*s3.Options)) (*s3.PutBucketVersioningOutput, error)
	GetBucketVersioning(context.Context, *s3.GetBucketVersioningInput, ...func(*s3.Options)) (*s3.GetBucketVersioningOutput, error)
	PutBucketCors(context.Context, *s3.PutBucketCorsInput, ...func(*s3.Options)) (*s3.PutBucketCorsOutput, error)
	GetBucketCors(context.Context, *s3.GetBucketCorsInput, ...func(*s3.Options)) (*s3.GetBucketCorsOutput, error)
	PutBucketLifecycleConfiguration(context.Context, *s3.PutBucketLifecycleConfigurationInput, ...func(*s3.Options)) (*s3.PutBucketLifecycleConfigurationOutput, error)
	GetBucketLifecycleConfiguration(context.Context, *s3.GetBucketLifecycleConfigurationInput, ...func(*s3.Options)) (*s3.GetBucketLifecycleConfigurationOutput, error)
	CreateMultipartUpload(context.Context, *s3.CreateMultipartUploadInput, ...func(*s3.Options)) (*s3.CreateMultipartUploadOutput, error)
	ListMultipartUploads(context.Context, *s3.ListMultipartUploadsInput, ...func(*s3.Options)) (*s3.ListMultipartUploadsOutput, error)
	AbortMultipartUpload(context.Context, *s3.AbortMultipartUploadInput, ...func(*s3.Options)) (*s3.AbortMultipartUploadOutput, error)
}

var _ s3ProvisionAPI = (*s3.Client)(nil)

type s3ProvisionAction struct {
	Name    string `json:"name"`
	Outcome string `json:"outcome"`
}

// s3ProvisionReport contains no endpoint, credential, provider response, or
// policy body. Bucket and public origin are the same non-secret identifiers
// exposed by the Node provisioning script.
type s3ProvisionReport struct {
	Version              int                 `json:"version"`
	Mode                 string              `json:"mode"`
	Status               string              `json:"status"`
	Bucket               string              `json:"bucket"`
	PrivatePolicy        string              `json:"privatePolicy"`
	Versioning           string              `json:"versioning"`
	CorsOrigin           string              `json:"corsOrigin"`
	CorsMode             string              `json:"corsMode"`
	MultipartCleanupMode string              `json:"multipartCleanupMode"`
	MultipartAbortDays   int                 `json:"multipartAbortDays"`
	Actions              []s3ProvisionAction `json:"actions"`
}

type s3ProvisionError struct {
	Code  string
	Cause error
}

func (e *s3ProvisionError) Error() string {
	if e == nil || strings.TrimSpace(e.Code) == "" {
		return "storage.provision_failed"
	}
	return e.Code
}

func (e *s3ProvisionError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func s3ProvisionFailure(code string, cause error) error {
	return &s3ProvisionError{Code: code, Cause: cause}
}

func s3ProvisionErrorCode(err error) string {
	var value *s3ProvisionError
	if errors.As(err, &value) && value != nil {
		return value.Code
	}
	return ""
}

func runProvision(args []string, stdout, stderr io.Writer) error {
	return runProvisionWithClient(args, stdout, stderr, nil)
}

func runProvisionWithClient(args []string, stdout, stderr io.Writer, injected s3ProvisionAPI) error {
	flags := newProvisionFlagSet()
	endpoint := flags.String("s3-endpoint", strings.TrimSpace(os.Getenv(config.WorkspaceS3EndpointEnv)), "private S3-compatible endpoint")
	region := flags.String("s3-region", envOrDefault(config.WorkspaceS3RegionEnv, defaultS3ProvisionRegion), "private S3 region")
	bucket := flags.String("s3-bucket", strings.TrimSpace(os.Getenv(config.WorkspaceS3BucketEnv)), "private S3 bucket")
	credentialsFile := flags.String("s3-credentials-file", strings.TrimSpace(os.Getenv(config.WorkspaceS3CredentialsFileEnv)), "private S3 credentials JSON file")
	publicBaseURL := flags.String("public-base-url", envOrDefault("PUBLIC_BASE_URL", defaultS3ProvisionOrigin), "HTTPS origin used by the restricted S3 CORS rule")
	timeout := flags.Duration("timeout", defaultVerifyTimeout, "bounded provisioning deadline")
	apply := flags.Bool("apply", false, "apply bucket configuration; omitted means read-only plan")
	if err := flags.Parse(args); err != nil {
		writeUsage(stderr)
		return s3ProvisionFailure("storage.provision_flags_invalid", err)
	}
	if flags.NArg() != 0 {
		return s3ProvisionFailure("storage.provision_flags_invalid", nil)
	}
	if *timeout <= 0 || *timeout > maximumVerifyTimeout {
		return s3ProvisionFailure("storage.provision_timeout_invalid", nil)
	}
	credentials, err := config.LoadS3Credentials(strings.TrimSpace(*credentialsFile))
	if err != nil {
		return s3ProvisionFailure("storage.provision_credentials_unavailable", nil)
	}
	provisionConfig, err := normalizeS3ProvisionConfig(s3ProvisionConfig{
		Endpoint: strings.TrimSpace(*endpoint), Region: strings.TrimSpace(*region), Bucket: strings.TrimSpace(*bucket),
		AccessKey: credentials.AccessKey, SecretKey: credentials.SecretKey, AppOrigin: strings.TrimSpace(*publicBaseURL),
	})
	if err != nil {
		return err
	}
	ctx, cancel := signalContext(*timeout)
	defer cancel()
	client := injected
	if client == nil {
		client, err = newS3ProvisionClient(provisionConfig)
		if err != nil {
			return err
		}
	}
	report, err := provisionS3Bucket(ctx, provisionConfig, *apply, client)
	if err != nil {
		if report.Mode != "" {
			report.Status = "partial"
			if reportErr := writeJSON(stdout, report); reportErr != nil {
				return reportErr
			}
		}
		return err
	}
	return writeJSON(stdout, report)
}

func newProvisionFlagSet() *flag.FlagSet {
	flags := flag.NewFlagSet("storage provision", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	return flags
}

func envOrDefault(name, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func normalizeS3ProvisionConfig(value s3ProvisionConfig) (s3ProvisionConfig, error) {
	endpoint, err := normalizeS3ProvisionURL(value.Endpoint, false)
	if err != nil {
		return s3ProvisionConfig{}, s3ProvisionFailure("storage.provision_config_invalid", err)
	}
	region := strings.TrimSpace(value.Region)
	if region == "" {
		region = defaultS3ProvisionRegion
	}
	if len(region) > s3ProvisionRegionMaxBytes {
		return s3ProvisionConfig{}, s3ProvisionFailure("storage.provision_config_invalid", nil)
	}
	bucket := strings.TrimSpace(value.Bucket)
	if len(bucket) > s3ProvisionBucketNameMaxBytes || !s3ProvisionBucketPattern.MatchString(bucket) {
		return s3ProvisionConfig{}, s3ProvisionFailure("storage.provision_config_invalid", nil)
	}
	if strings.TrimSpace(value.AccessKey) == "" || strings.TrimSpace(value.SecretKey) == "" {
		return s3ProvisionConfig{}, s3ProvisionFailure("storage.provision_credentials_unavailable", nil)
	}
	origin, err := normalizeS3ProvisionURL(value.AppOrigin, true)
	if err != nil {
		return s3ProvisionConfig{}, s3ProvisionFailure("storage.provision_config_invalid", err)
	}
	originURL, _ := url.Parse(origin)
	if originURL.Scheme != "https" {
		return s3ProvisionConfig{}, s3ProvisionFailure("storage.provision_config_invalid", nil)
	}
	return s3ProvisionConfig{
		Endpoint: endpoint, Region: region, Bucket: bucket,
		AccessKey: strings.TrimSpace(value.AccessKey), SecretKey: strings.TrimSpace(value.SecretKey), AppOrigin: origin,
	}, nil
}

func normalizeS3ProvisionURL(value string, httpsOnly bool) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Opaque != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", errors.New("S3 URL is invalid")
	}
	if httpsOnly {
		if parsed.Scheme != "https" {
			return "", errors.New("public origin must use HTTPS")
		}
	} else if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", errors.New("S3 URL is invalid")
	}
	return strings.TrimSuffix(parsed.String(), "/"), nil
}

func newS3ProvisionClient(value s3ProvisionConfig) (s3ProvisionAPI, error) {
	client := s3.NewFromConfig(aws.Config{
		Region: value.Region,
		Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
			return aws.Credentials{AccessKeyID: value.AccessKey, SecretAccessKey: value.SecretKey, Source: "workspace-s3-provision"}, nil
		}),
		BaseEndpoint: aws.String(value.Endpoint),
	}, func(options *s3.Options) {
		options.UsePathStyle = true
		options.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired
		options.ResponseChecksumValidation = aws.ResponseChecksumValidationWhenRequired
	})
	return client, nil
}

func provisionS3Bucket(ctx context.Context, value s3ProvisionConfig, apply bool, client s3ProvisionAPI) (s3ProvisionReport, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if client == nil {
		return s3ProvisionReport{}, s3ProvisionFailure("storage.provision_client_required", nil)
	}
	config, err := normalizeS3ProvisionConfig(value)
	if err != nil {
		return s3ProvisionReport{}, err
	}
	if err := ctx.Err(); err != nil {
		return s3ProvisionReport{}, s3ProvisionFailure("storage.provision_interrupted", err)
	}
	if apply {
		return applyS3Provision(ctx, config, client)
	}
	return planS3Provision(ctx, config, client)
}

func newS3ProvisionReport(config s3ProvisionConfig, mode string) s3ProvisionReport {
	return s3ProvisionReport{
		Version: 1, Mode: mode, Status: "in_progress", Bucket: config.Bucket, PrivatePolicy: "not_checked",
		Versioning: "not_checked", CorsOrigin: config.AppOrigin,
		MultipartAbortDays: s3ProvisionMultipartAbortDays, Actions: make([]s3ProvisionAction, 0, 3),
	}
}

func planS3Provision(ctx context.Context, config s3ProvisionConfig, client s3ProvisionAPI) (s3ProvisionReport, error) {
	report := newS3ProvisionReport(config, "plan")
	if err := headS3Bucket(ctx, client, config.Bucket); err != nil {
		return report, err
	}
	if _, err := verifyPrivateS3Policy(ctx, client, config.Bucket); err != nil {
		return report, err
	}
	report.PrivatePolicy = "verified"

	versioning, err := client.GetBucketVersioning(ctx, &s3.GetBucketVersioningInput{Bucket: aws.String(config.Bucket)})
	if err != nil {
		return report, s3ProvisionFailure("storage.provision_versioning_check_failed", err)
	}
	report.Versioning = s3ProvisionVersioningStatus(versioning)
	if versioning != nil && versioning.Status == s3types.BucketVersioningStatusEnabled {
		report.Actions = append(report.Actions, s3ProvisionAction{Name: "versioning", Outcome: "unchanged"})
	} else {
		report.Actions = append(report.Actions, s3ProvisionAction{Name: "versioning", Outcome: "would_enable"})
	}

	cors, corsOutcome, corsErr := inspectS3Cors(ctx, client, config)
	if corsErr != nil {
		return report, corsErr
	}
	report.CorsMode = cors.mode
	report.Actions = append(report.Actions, s3ProvisionAction{Name: "cors", Outcome: corsOutcome})

	lifecycle, lifecycleOutcome, lifecycleErr := inspectS3Lifecycle(ctx, client, config)
	if lifecycleErr != nil {
		return report, lifecycleErr
	}
	report.MultipartCleanupMode = lifecycle.mode
	report.Actions = append(report.Actions, s3ProvisionAction{Name: "multipart_lifecycle", Outcome: lifecycleOutcome})
	report.Status = "planned"
	return report, nil
}

type s3ProvisionCapability struct {
	mode string
}

func inspectS3Cors(ctx context.Context, client s3ProvisionAPI, config s3ProvisionConfig) (s3ProvisionCapability, string, error) {
	current, err := client.GetBucketCors(ctx, &s3.GetBucketCorsInput{Bucket: aws.String(config.Bucket)})
	if err != nil {
		if isS3ProvisionUnsupported(err) {
			return s3ProvisionCapability{mode: "gateway"}, "gateway_fallback", nil
		}
		if isS3ProvisionNotFound(err) {
			return s3ProvisionCapability{mode: "bucket"}, "would_configure", nil
		}
		return s3ProvisionCapability{}, "", s3ProvisionFailure("storage.provision_cors_check_failed", err)
	}
	if current != nil && s3CorsMatches(current.CORSRules, config.AppOrigin) {
		return s3ProvisionCapability{mode: "bucket"}, "unchanged", nil
	}
	return s3ProvisionCapability{mode: "bucket"}, "would_configure", nil
}

func inspectS3Lifecycle(ctx context.Context, client s3ProvisionAPI, config s3ProvisionConfig) (s3ProvisionCapability, string, error) {
	current, err := client.GetBucketLifecycleConfiguration(ctx, &s3.GetBucketLifecycleConfigurationInput{Bucket: aws.String(config.Bucket)})
	if err != nil {
		if isS3ProvisionLifecycleFallback(err) {
			return s3ProvisionCapability{mode: "application"}, "application_fallback", nil
		}
		if isS3ProvisionNotFound(err) {
			return s3ProvisionCapability{mode: "bucket"}, "would_configure", nil
		}
		return s3ProvisionCapability{}, "", s3ProvisionFailure("storage.provision_lifecycle_check_failed", err)
	}
	if current != nil && s3LifecycleMatches(current.Rules) {
		return s3ProvisionCapability{mode: "bucket"}, "unchanged", nil
	}
	return s3ProvisionCapability{mode: "bucket"}, "would_configure", nil
}

func applyS3Provision(ctx context.Context, config s3ProvisionConfig, client s3ProvisionAPI) (s3ProvisionReport, error) {
	report := newS3ProvisionReport(config, "apply")
	if err := headS3Bucket(ctx, client, config.Bucket); err != nil {
		return report, err
	}
	if _, err := verifyPrivateS3Policy(ctx, client, config.Bucket); err != nil {
		return report, err
	}
	report.PrivatePolicy = "verified"
	if _, err := client.PutBucketVersioning(ctx, &s3.PutBucketVersioningInput{
		Bucket:                  aws.String(config.Bucket),
		VersioningConfiguration: &s3types.VersioningConfiguration{Status: s3types.BucketVersioningStatusEnabled},
	}); err != nil {
		return report, s3ProvisionFailure("storage.provision_versioning_failed", err)
	}
	report.Actions = append(report.Actions, s3ProvisionAction{Name: "versioning", Outcome: "configured"})

	report.CorsMode = "bucket"
	if _, err := client.PutBucketCors(ctx, &s3.PutBucketCorsInput{
		Bucket: aws.String(config.Bucket), CORSConfiguration: desiredS3Cors(config.AppOrigin),
	}); err != nil {
		if isS3ProvisionUnsupported(err) {
			report.CorsMode = "gateway"
			report.Actions = append(report.Actions, s3ProvisionAction{Name: "cors", Outcome: "gateway_fallback"})
		} else {
			return report, s3ProvisionFailure("storage.provision_cors_failed", err)
		}
	} else {
		report.Actions = append(report.Actions, s3ProvisionAction{Name: "cors", Outcome: "configured"})
	}

	report.MultipartCleanupMode = "bucket"
	if _, err := client.PutBucketLifecycleConfiguration(ctx, &s3.PutBucketLifecycleConfigurationInput{
		Bucket: aws.String(config.Bucket), LifecycleConfiguration: desiredS3Lifecycle(),
	}); err != nil {
		if isS3ProvisionLifecycleFallback(err) {
			report.MultipartCleanupMode = "application"
			report.Actions = append(report.Actions, s3ProvisionAction{Name: "multipart_lifecycle", Outcome: "application_fallback"})
		} else {
			return report, s3ProvisionFailure("storage.provision_lifecycle_failed", err)
		}
	} else {
		report.Actions = append(report.Actions, s3ProvisionAction{Name: "multipart_lifecycle", Outcome: "configured"})
	}

	verifiedVersioning, err := verifyS3ProvisionResult(ctx, config, client, report.CorsMode, report.MultipartCleanupMode)
	if err != nil {
		return report, err
	}
	report.Versioning = verifiedVersioning
	if _, err := verifyPrivateS3Policy(ctx, client, config.Bucket); err != nil {
		return report, err
	}
	report.PrivatePolicy = "verified"
	report.Status = "completed"
	return report, nil
}

func verifyS3ProvisionResult(ctx context.Context, config s3ProvisionConfig, client s3ProvisionAPI, corsMode, lifecycleMode string) (string, error) {
	versioning, err := client.GetBucketVersioning(ctx, &s3.GetBucketVersioningInput{Bucket: aws.String(config.Bucket)})
	if err != nil || versioning == nil || versioning.Status != s3types.BucketVersioningStatusEnabled {
		return "", s3ProvisionFailure("storage.provision_versioning_verification_failed", err)
	}
	if corsMode == "bucket" {
		cors, getErr := client.GetBucketCors(ctx, &s3.GetBucketCorsInput{Bucket: aws.String(config.Bucket)})
		if getErr != nil || cors == nil || !s3CorsMatches(cors.CORSRules, config.AppOrigin) {
			return "", s3ProvisionFailure("storage.provision_cors_verification_failed", getErr)
		}
	}
	if lifecycleMode == "bucket" {
		lifecycle, getErr := client.GetBucketLifecycleConfiguration(ctx, &s3.GetBucketLifecycleConfigurationInput{Bucket: aws.String(config.Bucket)})
		if getErr != nil || lifecycle == nil || !s3LifecycleMatches(lifecycle.Rules) {
			return "", s3ProvisionFailure("storage.provision_lifecycle_verification_failed", getErr)
		}
	} else if lifecycleMode == "application" {
		if err := verifyS3MultipartCleanupAccess(ctx, config.Bucket, client); err != nil {
			return "", err
		}
	}
	return s3ProvisionVersioningStatus(versioning), nil
}

func s3ProvisionVersioningStatus(output *s3.GetBucketVersioningOutput) string {
	if output == nil {
		return ""
	}
	return string(output.Status)
}

func headS3Bucket(ctx context.Context, client s3ProvisionAPI, bucket string) error {
	if _, err := client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(bucket)}); err != nil {
		return s3ProvisionFailure("storage.provision_bucket_unavailable", err)
	}
	return nil
}

func verifyPrivateS3Policy(ctx context.Context, client s3ProvisionAPI, bucket string) (bool, error) {
	response, err := client.GetBucketPolicy(ctx, &s3.GetBucketPolicyInput{Bucket: aws.String(bucket)})
	if err != nil {
		if isS3ProvisionNotFound(err) {
			return true, nil
		}
		return false, s3ProvisionFailure("storage.provision_private_policy_check_failed", err)
	}
	policy := ""
	if response != nil && response.Policy != nil {
		policy = *response.Policy
	}
	if len(policy) > maxS3ProvisionPolicyBytes {
		return false, s3ProvisionFailure("storage.provision_policy_invalid", nil)
	}
	public, parseErr := s3PolicyIsPublic(policy)
	if parseErr != nil {
		return false, s3ProvisionFailure("storage.provision_policy_invalid", parseErr)
	}
	if public {
		return false, s3ProvisionFailure("storage.provision_public_bucket", nil)
	}
	return true, nil
}

func s3PolicyIsPublic(policy string) (bool, error) {
	trimmedPolicy := strings.TrimSpace(policy)
	if trimmedPolicy == "" {
		return false, nil
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmedPolicy), &document); err != nil {
		return false, err
	}
	if document == nil {
		return false, errors.New("policy must be a JSON object")
	}
	statementRaw, ok := document["Statement"]
	if !ok {
		return false, errors.New("policy statement is missing")
	}
	trimmedStatement := strings.TrimSpace(string(statementRaw))
	if trimmedStatement == "" || trimmedStatement == "null" {
		return false, errors.New("policy statement is invalid")
	}
	type s3PolicyStatement struct {
		Effect       string          `json:"Effect"`
		Principal    json.RawMessage `json:"Principal"`
		NotPrincipal json.RawMessage `json:"NotPrincipal"`
	}
	var statements []s3PolicyStatement
	switch trimmedStatement[0] {
	case '[':
		if err := json.Unmarshal([]byte(trimmedStatement), &statements); err != nil {
			return false, err
		}
		if len(statements) == 0 {
			return false, errors.New("policy statement is empty")
		}
	case '{':
		var statement s3PolicyStatement
		if err := json.Unmarshal([]byte(trimmedStatement), &statement); err != nil {
			return false, err
		}
		statements = append(statements, statement)
	default:
		return false, errors.New("policy statement must be an object or array")
	}
	for _, statement := range statements {
		switch statement.Effect {
		case "Allow":
			if statement.NotPrincipal != nil || s3PolicyPrincipalIsPublic(statement.Principal) {
				return true, nil
			}
		case "Deny":
		default:
			return false, errors.New("policy statement effect is invalid")
		}
	}
	return false, nil
}

func s3PolicyPrincipalIsPublic(raw json.RawMessage) bool {
	if len(raw) == 0 || string(raw) == "null" {
		return false
	}
	var value string
	if json.Unmarshal(raw, &value) == nil {
		return value == "*"
	}
	var values []json.RawMessage
	if json.Unmarshal(raw, &values) == nil {
		for _, item := range values {
			if s3PolicyPrincipalIsPublic(item) {
				return true
			}
		}
		return false
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) == nil {
		for _, item := range object {
			if s3PolicyPrincipalIsPublic(item) {
				return true
			}
		}
	}
	return false
}

func desiredS3Cors(origin string) *s3types.CORSConfiguration {
	return &s3types.CORSConfiguration{CORSRules: []s3types.CORSRule{{
		AllowedOrigins: []string{origin}, AllowedMethods: []string{"GET", "HEAD"}, AllowedHeaders: []string{"*"},
		ExposeHeaders: []string{"ETag", "Content-Length", "Content-Type"}, MaxAgeSeconds: aws.Int32(300),
	}}}
}

func s3CorsMatches(rules []s3types.CORSRule, origin string) bool {
	if len(rules) != 1 {
		return false
	}
	rule := rules[0]
	return equalS3Strings(rule.AllowedOrigins, []string{origin}) &&
		equalS3Strings(rule.AllowedMethods, []string{"GET", "HEAD"}) &&
		equalS3Strings(rule.AllowedHeaders, []string{"*"}) &&
		equalS3Strings(rule.ExposeHeaders, []string{"ETag", "Content-Length", "Content-Type"}) &&
		rule.MaxAgeSeconds != nil && *rule.MaxAgeSeconds == 300
}

func desiredS3Lifecycle() *s3types.BucketLifecycleConfiguration {
	return &s3types.BucketLifecycleConfiguration{Rules: []s3types.LifecycleRule{{
		ID: aws.String("abort-incomplete-multipart-after-7-days"), Status: s3types.ExpirationStatusEnabled,
		// Node's contract sends the legacy empty Prefix element. Keep that wire
		// shape instead of changing the persisted rule to a different filter form.
		Prefix: aws.String(""), AbortIncompleteMultipartUpload: &s3types.AbortIncompleteMultipartUpload{DaysAfterInitiation: aws.Int32(s3ProvisionMultipartAbortDays)},
	}}}
}

func s3LifecycleMatches(rules []s3types.LifecycleRule) bool {
	for _, rule := range rules {
		if rule.ID == nil || *rule.ID != "abort-incomplete-multipart-after-7-days" || rule.Status != s3types.ExpirationStatusEnabled ||
			rule.AbortIncompleteMultipartUpload == nil || rule.AbortIncompleteMultipartUpload.DaysAfterInitiation == nil ||
			*rule.AbortIncompleteMultipartUpload.DaysAfterInitiation != s3ProvisionMultipartAbortDays {
			continue
		}
		//lint:ignore SA1019 S3 Node compatibility requires accepting the legacy Prefix element.
		if rule.Prefix != nil && *rule.Prefix != "" {
			continue
		}
		if rule.Filter != nil {
			if rule.Filter.Prefix != nil && *rule.Filter.Prefix != "" {
				continue
			}
			if rule.Filter.Tag != nil || rule.Filter.And != nil || rule.Filter.ObjectSizeGreaterThan != nil || rule.Filter.ObjectSizeLessThan != nil {
				continue
			}
		}
		return true
	}
	return false
}

func equalS3Strings(left, right []string) bool {
	leftCopy := append([]string(nil), left...)
	rightCopy := append([]string(nil), right...)
	sort.Strings(leftCopy)
	sort.Strings(rightCopy)
	if len(leftCopy) != len(rightCopy) {
		return false
	}
	for index := range leftCopy {
		if leftCopy[index] != rightCopy[index] {
			return false
		}
	}
	return true
}

func verifyS3MultipartCleanupAccess(ctx context.Context, bucket string, client s3ProvisionAPI) (err error) {
	key := "workspace/migration-archive/provisioning/multipart-cleanup-canary-" + uuid.NewString()
	created, err := client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket: aws.String(bucket), Key: aws.String(key), ContentType: aws.String("application/octet-stream"),
		Metadata: map[string]string{"duallane-kind": "multipart-cleanup-canary", "duallane-id": "provisioning"},
	})
	if err != nil {
		return s3ProvisionFailure("storage.provision_multipart_access_failed", err)
	}
	if created == nil || created.UploadId == nil || strings.TrimSpace(*created.UploadId) == "" {
		return s3ProvisionFailure("storage.provision_multipart_canary_failed", nil)
	}
	uploadID := *created.UploadId
	defer func() {
		cleanupContext, cleanupCancel := context.WithTimeout(context.WithoutCancel(ctx), s3ProvisionCleanupTimeout)
		defer cleanupCancel()
		_, cleanupErr := client.AbortMultipartUpload(cleanupContext, &s3.AbortMultipartUploadInput{Bucket: aws.String(bucket), Key: aws.String(key), UploadId: aws.String(uploadID)})
		if cleanupErr != nil {
			err = s3ProvisionFailure("storage.provision_multipart_cleanup_failed", errors.Join(err, cleanupErr))
		}
	}()
	if _, err := client.ListMultipartUploads(ctx, &s3.ListMultipartUploadsInput{Bucket: aws.String(bucket), Prefix: aws.String("workspace/"), MaxUploads: aws.Int32(s3ProvisionCanaryMaxUploads)}); err != nil {
		return s3ProvisionFailure("storage.provision_multipart_access_failed", err)
	}
	return nil
}

func isS3ProvisionNotFound(err error) bool {
	if err == nil {
		return false
	}
	var value interface{ ErrorCode() string }
	if errors.As(err, &value) {
		switch value.ErrorCode() {
		case "NoSuchBucketPolicy", "NoSuchPolicy", "NoSuchCORS", "NoSuchLifecycleConfiguration", "NoSuchBucket", "NotFound", "NotFoundError":
			return true
		}
	}
	var status interface{ HTTPStatusCode() int }
	return errors.As(err, &status) && status.HTTPStatusCode() == 404
}

func isS3ProvisionUnsupported(err error) bool {
	if err == nil {
		return false
	}
	var value interface{ ErrorCode() string }
	if errors.As(err, &value) && value.ErrorCode() == "NotImplemented" {
		return true
	}
	var status interface{ HTTPStatusCode() int }
	return errors.As(err, &status) && status.HTTPStatusCode() == 501
}

func isS3ProvisionLifecycleFallback(err error) bool {
	if isS3ProvisionUnsupported(err) {
		return true
	}
	var value interface{ ErrorCode() string }
	return errors.As(err, &value) && value.ErrorCode() == "InvalidArgument"
}
