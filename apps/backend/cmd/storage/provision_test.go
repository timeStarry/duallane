package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type provisionFakeAPI struct {
	commands          []string
	headErr           error
	policy            *string
	versioning        *s3types.VersioningConfiguration
	getVersioningErr  error
	cors              *s3types.CORSConfiguration
	lifecycle         *s3types.BucketLifecycleConfiguration
	getCorsErr        error
	putCorsErr        error
	getLifecycleErr   error
	putLifecycleErr   error
	createUploadErr   error
	listUploadErr     error
	abortUploadErr    error
	uploadID          string
	aborted           bool
	createInput       *s3.CreateMultipartUploadInput
	listInput         *s3.ListMultipartUploadsInput
	abortInput        *s3.AbortMultipartUploadInput
	cancelAfterCreate context.CancelFunc
	cleanupDeadline   time.Time
}

func (f *provisionFakeAPI) record(name string) { f.commands = append(f.commands, name) }

func (f *provisionFakeAPI) HeadBucket(context.Context, *s3.HeadBucketInput, ...func(*s3.Options)) (*s3.HeadBucketOutput, error) {
	f.record("HeadBucket")
	return &s3.HeadBucketOutput{}, f.headErr
}
func (f *provisionFakeAPI) GetBucketPolicy(context.Context, *s3.GetBucketPolicyInput, ...func(*s3.Options)) (*s3.GetBucketPolicyOutput, error) {
	f.record("GetBucketPolicy")
	if f.policy == nil {
		return &s3.GetBucketPolicyOutput{}, nil
	}
	return &s3.GetBucketPolicyOutput{Policy: f.policy}, nil
}
func (f *provisionFakeAPI) PutBucketVersioning(_ context.Context, input *s3.PutBucketVersioningInput, _ ...func(*s3.Options)) (*s3.PutBucketVersioningOutput, error) {
	f.record("PutBucketVersioning")
	f.versioning = input.VersioningConfiguration
	return &s3.PutBucketVersioningOutput{}, nil
}
func (f *provisionFakeAPI) GetBucketVersioning(context.Context, *s3.GetBucketVersioningInput, ...func(*s3.Options)) (*s3.GetBucketVersioningOutput, error) {
	f.record("GetBucketVersioning")
	if f.getVersioningErr != nil {
		return nil, f.getVersioningErr
	}
	return &s3.GetBucketVersioningOutput{Status: f.versioningStatus()}, nil
}
func (f *provisionFakeAPI) versioningStatus() s3types.BucketVersioningStatus {
	if f.versioning == nil {
		return ""
	}
	return f.versioning.Status
}
func (f *provisionFakeAPI) PutBucketCors(_ context.Context, input *s3.PutBucketCorsInput, _ ...func(*s3.Options)) (*s3.PutBucketCorsOutput, error) {
	f.record("PutBucketCors")
	if f.putCorsErr != nil {
		return nil, f.putCorsErr
	}
	f.cors = input.CORSConfiguration
	return &s3.PutBucketCorsOutput{}, nil
}
func (f *provisionFakeAPI) GetBucketCors(context.Context, *s3.GetBucketCorsInput, ...func(*s3.Options)) (*s3.GetBucketCorsOutput, error) {
	f.record("GetBucketCors")
	if f.getCorsErr != nil {
		return nil, f.getCorsErr
	}
	if f.cors == nil {
		return &s3.GetBucketCorsOutput{}, nil
	}
	return &s3.GetBucketCorsOutput{CORSRules: f.cors.CORSRules}, nil
}
func (f *provisionFakeAPI) PutBucketLifecycleConfiguration(_ context.Context, input *s3.PutBucketLifecycleConfigurationInput, _ ...func(*s3.Options)) (*s3.PutBucketLifecycleConfigurationOutput, error) {
	f.record("PutBucketLifecycleConfiguration")
	if f.putLifecycleErr != nil {
		return nil, f.putLifecycleErr
	}
	f.lifecycle = input.LifecycleConfiguration
	return &s3.PutBucketLifecycleConfigurationOutput{}, nil
}
func (f *provisionFakeAPI) GetBucketLifecycleConfiguration(context.Context, *s3.GetBucketLifecycleConfigurationInput, ...func(*s3.Options)) (*s3.GetBucketLifecycleConfigurationOutput, error) {
	f.record("GetBucketLifecycleConfiguration")
	if f.getLifecycleErr != nil {
		return nil, f.getLifecycleErr
	}
	if f.lifecycle == nil {
		return &s3.GetBucketLifecycleConfigurationOutput{}, nil
	}
	return &s3.GetBucketLifecycleConfigurationOutput{Rules: f.lifecycle.Rules}, nil
}
func (f *provisionFakeAPI) CreateMultipartUpload(_ context.Context, input *s3.CreateMultipartUploadInput, _ ...func(*s3.Options)) (*s3.CreateMultipartUploadOutput, error) {
	f.record("CreateMultipartUpload")
	f.createInput = input
	if f.createUploadErr != nil {
		return nil, f.createUploadErr
	}
	if f.cancelAfterCreate != nil {
		f.cancelAfterCreate()
		f.cancelAfterCreate = nil
	}
	return &s3.CreateMultipartUploadOutput{UploadId: aws.String(f.uploadID)}, nil
}
func (f *provisionFakeAPI) ListMultipartUploads(ctx context.Context, input *s3.ListMultipartUploadsInput, _ ...func(*s3.Options)) (*s3.ListMultipartUploadsOutput, error) {
	f.record("ListMultipartUploads")
	f.listInput = input
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f.listUploadErr != nil {
		return nil, f.listUploadErr
	}
	return &s3.ListMultipartUploadsOutput{}, nil
}
func (f *provisionFakeAPI) AbortMultipartUpload(ctx context.Context, input *s3.AbortMultipartUploadInput, _ ...func(*s3.Options)) (*s3.AbortMultipartUploadOutput, error) {
	f.record("AbortMultipartUpload")
	f.abortInput = input
	if deadline, ok := ctx.Deadline(); ok {
		f.cleanupDeadline = deadline
	}
	f.aborted = true
	return &s3.AbortMultipartUploadOutput{}, f.abortUploadErr
}

func testS3ProvisionConfig() s3ProvisionConfig {
	return s3ProvisionConfig{
		Endpoint: "http://s3.internal:9000", Region: "us-east-1", Bucket: "duallane",
		AccessKey: "synthetic-access", SecretKey: "synthetic-secret", AppOrigin: "https://duallane.tsio.top",
	}
}

func TestS3ProvisionPlanIsReadOnlyAndReportsNodeContract(t *testing.T) {
	fake := &provisionFakeAPI{}
	report, err := provisionS3Bucket(context.Background(), testS3ProvisionConfig(), false, fake)
	if err != nil {
		t.Fatal(err)
	}
	if report.Mode != "plan" || report.Status != "planned" || report.CorsMode != "bucket" || report.MultipartCleanupMode != "bucket" || report.Versioning != "" {
		t.Fatalf("report=%+v", report)
	}
	if strings.Contains(string(mustJSON(t, report)), "synthetic-secret") || strings.Contains(string(mustJSON(t, report)), "s3.internal") {
		t.Fatal("plan report leaked credentials or endpoint")
	}
	for _, command := range fake.commands {
		if strings.HasPrefix(command, "Put") || command == "CreateMultipartUpload" || command == "AbortMultipartUpload" {
			t.Fatalf("read-only plan issued mutating command %q", command)
		}
	}
}

func TestS3ProvisionCommandDefaultsToPlanAndRequiresExplicitApply(t *testing.T) {
	credentialsPath := filepath.Join(t.TempDir(), "credentials.json")
	if err := os.WriteFile(credentialsPath, []byte(`{"accessKey":"synthetic-access","secretKey":"synthetic-secret"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	args := []string{
		"--s3-endpoint", "http://s3.internal:9000",
		"--s3-region", "us-east-1",
		"--s3-bucket", "duallane",
		"--s3-credentials-file", credentialsPath,
		"--public-base-url", "https://duallane.tsio.top",
	}
	readOnlyFake := &provisionFakeAPI{}
	var output strings.Builder
	if err := runProvisionWithClient(args, &output, &output, readOnlyFake); err != nil {
		t.Fatal(err)
	}
	if report := mustDecodeReport(t, output.String()); report.Mode != "plan" || report.Status != "planned" {
		t.Fatalf("default command report=%+v", report)
	}
	if containsCommand(readOnlyFake.commands, "PutBucketVersioning") {
		t.Fatalf("default command unexpectedly mutated bucket: %v", readOnlyFake.commands)
	}

	applyFake := &provisionFakeAPI{}
	output.Reset()
	args = append(args, "--apply")
	if err := runProvisionWithClient(args, &output, &output, applyFake); err != nil {
		t.Fatal(err)
	}
	if report := mustDecodeReport(t, output.String()); report.Mode != "apply" || report.Status != "completed" {
		t.Fatalf("apply command report=%+v", report)
	}
	if !containsCommand(applyFake.commands, "PutBucketVersioning") {
		t.Fatalf("explicit apply did not configure bucket: %v", applyFake.commands)
	}
}

func TestS3ProvisionApplyConfiguresAndRevalidatesBucket(t *testing.T) {
	fake := &provisionFakeAPI{uploadID: "synthetic-upload"}
	report, err := provisionS3Bucket(context.Background(), testS3ProvisionConfig(), true, fake)
	if err != nil {
		t.Fatal(err)
	}
	if report.Mode != "apply" || report.Status != "completed" || report.CorsMode != "bucket" || report.MultipartCleanupMode != "bucket" || report.Versioning != string(s3types.BucketVersioningStatusEnabled) {
		t.Fatalf("report=%+v", report)
	}
	if !s3CorsMatches(fake.cors.CORSRules, testS3ProvisionConfig().AppOrigin) || !s3LifecycleMatches(fake.lifecycle.Rules) || fake.versioningStatus() != s3types.BucketVersioningStatusEnabled {
		t.Fatalf("configured state versioning=%q cors=%#v lifecycle=%#v", fake.versioningStatus(), fake.cors, fake.lifecycle)
	}
	if containsCommand(fake.commands, "CreateMultipartUpload") || containsCommand(fake.commands, "AbortMultipartUpload") {
		t.Fatal("bucket lifecycle path unexpectedly used application canary")
	}
	if !containsCommand(fake.commands, "GetBucketPolicy") || countCommand(fake.commands, "GetBucketPolicy") != 2 {
		t.Fatalf("private policy was not checked before and after apply: %v", fake.commands)
	}
}

func TestS3ProvisionDoesNotReportVersioningBeforeVerification(t *testing.T) {
	fake := &provisionFakeAPI{getVersioningErr: apiRawError{message: "provider verification failure"}}
	report, err := provisionS3Bucket(context.Background(), testS3ProvisionConfig(), true, fake)
	if s3ProvisionErrorCode(err) != "storage.provision_versioning_verification_failed" {
		t.Fatalf("code=%q err=%v report=%+v", s3ProvisionErrorCode(err), err, report)
	}
	if report.Versioning == string(s3types.BucketVersioningStatusEnabled) {
		t.Fatalf("unverified versioning was reported as enabled: %+v", report)
	}
	if len(report.Actions) == 0 || report.Actions[0] != (s3ProvisionAction{Name: "versioning", Outcome: "configured"}) {
		t.Fatalf("versioning action did not distinguish configuration from verification: %+v", report.Actions)
	}
}

func TestS3ProvisionRejectsPublicPolicyBeforeMutation(t *testing.T) {
	policy := `{"Statement":{"Effect":"Allow","Principal":"*","Action":"s3:GetObject"}}`
	fake := &provisionFakeAPI{policy: aws.String(policy)}
	_, err := provisionS3Bucket(context.Background(), testS3ProvisionConfig(), true, fake)
	if s3ProvisionErrorCode(err) != "storage.provision_public_bucket" {
		t.Fatalf("code=%q err=%v", s3ProvisionErrorCode(err), err)
	}
	for _, command := range fake.commands {
		if strings.HasPrefix(command, "Put") {
			t.Fatalf("mutation followed public policy: %v", fake.commands)
		}
	}
}

func TestS3ProvisionRejectsUnprovenNotPrincipalBeforeMutation(t *testing.T) {
	fake := &provisionFakeAPI{policy: aws.String(`{"Statement":{"Effect":"Allow","NotPrincipal":{"AWS":"arn:aws:iam::123:role/private"}}}`)}
	_, err := provisionS3Bucket(context.Background(), testS3ProvisionConfig(), true, fake)
	if s3ProvisionErrorCode(err) != "storage.provision_public_bucket" {
		t.Fatalf("code=%q err=%v", s3ProvisionErrorCode(err), err)
	}
	if len(fake.commands) != 2 || fake.commands[0] != "HeadBucket" || fake.commands[1] != "GetBucketPolicy" {
		t.Fatalf("NotPrincipal rejection occurred after mutation: %v", fake.commands)
	}
}

func TestS3ProvisionRejectsNullPolicyBeforeMutation(t *testing.T) {
	fake := &provisionFakeAPI{policy: aws.String("null")}
	_, err := provisionS3Bucket(context.Background(), testS3ProvisionConfig(), true, fake)
	if s3ProvisionErrorCode(err) != "storage.provision_policy_invalid" {
		t.Fatalf("code=%q err=%v", s3ProvisionErrorCode(err), err)
	}
	if len(fake.commands) != 2 || fake.commands[0] != "HeadBucket" || fake.commands[1] != "GetBucketPolicy" {
		t.Fatalf("null policy rejection occurred after mutation: %v", fake.commands)
	}
}

func TestS3PolicyRequiresAnObjectAndValidStatement(t *testing.T) {
	for _, policy := range []string{
		"null",
		"[]",
		`{"Statement":null}`,
		`{"Statement":[]}`,
		`{"Statement":{}}`,
		`{"Statement":"Allow"}`,
	} {
		public, err := s3PolicyIsPublic(policy)
		if err == nil || public {
			t.Fatalf("policy=%s public=%t err=%v", policy, public, err)
		}
	}
}

func TestS3ProvisionUsesNodeFallbackModes(t *testing.T) {
	fake := &provisionFakeAPI{
		putCorsErr:      apiCodeError{code: "NotImplemented"},
		putLifecycleErr: apiCodeError{code: "InvalidArgument"},
		uploadID:        "synthetic-upload",
	}
	report, err := provisionS3Bucket(context.Background(), testS3ProvisionConfig(), true, fake)
	if err != nil {
		t.Fatal(err)
	}
	if report.CorsMode != "gateway" || report.MultipartCleanupMode != "application" || !fake.aborted {
		t.Fatalf("fallback report=%+v commands=%v aborted=%t", report, fake.commands, fake.aborted)
	}
	if !containsCommand(fake.commands, "CreateMultipartUpload") || !containsCommand(fake.commands, "ListMultipartUploads") || !containsCommand(fake.commands, "AbortMultipartUpload") {
		t.Fatalf("application cleanup canary was incomplete: %v", fake.commands)
	}
	if fake.createInput == nil || fake.createInput.Key == nil || !strings.HasPrefix(*fake.createInput.Key, "workspace/migration-archive/provisioning/multipart-cleanup-canary-") || fake.createInput.ContentType == nil || *fake.createInput.ContentType != "application/octet-stream" || fake.createInput.Metadata["duallane-kind"] != "multipart-cleanup-canary" || fake.createInput.Metadata["duallane-id"] != "provisioning" {
		t.Fatalf("canary create input did not preserve Node contract: %#v", fake.createInput)
	}
	if fake.listInput == nil || fake.listInput.Prefix == nil || *fake.listInput.Prefix != "workspace/" || fake.listInput.MaxUploads == nil || *fake.listInput.MaxUploads != 1 {
		t.Fatalf("canary list input did not preserve Node contract: %#v", fake.listInput)
	}
	if fake.abortInput == nil || fake.abortInput.Key == nil || fake.abortInput.UploadId == nil || *fake.abortInput.Key != *fake.createInput.Key || *fake.abortInput.UploadId != fake.uploadID {
		t.Fatalf("canary abort input did not match created upload: %#v", fake.abortInput)
	}
}

func TestS3ProvisionCancellationUsesBoundedIndependentCanaryCleanup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fake := &provisionFakeAPI{
		putCorsErr:        apiCodeError{code: "NotImplemented"},
		putLifecycleErr:   apiCodeError{code: "InvalidArgument"},
		uploadID:          "synthetic-upload",
		cancelAfterCreate: cancel,
	}
	_, err := provisionS3Bucket(ctx, testS3ProvisionConfig(), true, fake)
	if s3ProvisionErrorCode(err) != "storage.provision_multipart_access_failed" {
		t.Fatalf("code=%q err=%v", s3ProvisionErrorCode(err), err)
	}
	if !fake.aborted {
		t.Fatal("canceled canary was not aborted")
	}
	if fake.cleanupDeadline.IsZero() || !fake.cleanupDeadline.After(time.Now()) || time.Until(fake.cleanupDeadline) > s3ProvisionCleanupTimeout {
		t.Fatalf("cleanup context was not independently bounded: %v", fake.cleanupDeadline)
	}
}

func TestS3ProvisionPlanRecognizesUnsupportedReadAPIsWithoutWrites(t *testing.T) {
	fake := &provisionFakeAPI{
		getCorsErr:      apiCodeError{code: "NotImplemented"},
		getLifecycleErr: apiCodeError{code: "InvalidArgument"},
	}
	report, err := provisionS3Bucket(context.Background(), testS3ProvisionConfig(), false, fake)
	if err != nil {
		t.Fatal(err)
	}
	if report.CorsMode != "gateway" || report.MultipartCleanupMode != "application" {
		t.Fatalf("fallback plan=%+v", report)
	}
	for _, command := range fake.commands {
		if strings.HasPrefix(command, "Put") || command == "CreateMultipartUpload" || command == "AbortMultipartUpload" {
			t.Fatalf("plan mutated after unsupported read: %v", fake.commands)
		}
	}
}

func TestS3ProvisionHTTPUsesConcreteAWSClientAgainstSyntheticS3(t *testing.T) {
	type request struct {
		operation string
		body      string
	}
	var requests []request
	versioningEnabled := false
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, httpRequest *http.Request) {
		body, err := io.ReadAll(io.LimitReader(httpRequest.Body, 128<<10))
		if err != nil {
			http.Error(writer, "synthetic read failure", http.StatusInternalServerError)
			return
		}
		operation := syntheticS3Operation(httpRequest)
		requests = append(requests, request{operation: operation, body: string(body)})
		if httpRequest.URL.Path != "/duallane" {
			http.Error(writer, "synthetic path failure", http.StatusNotFound)
			return
		}
		switch operation {
		case "head":
			writer.WriteHeader(http.StatusOK)
		case "get-policy":
			writer.Header().Set("Content-Type", "application/xml")
			writer.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(writer, `<Error><Code>NoSuchBucketPolicy</Code><Message>synthetic</Message></Error>`)
		case "put-versioning":
			versioningEnabled = true
			writer.WriteHeader(http.StatusOK)
		case "put-cors", "put-lifecycle":
			writer.WriteHeader(http.StatusOK)
		case "get-versioning":
			if versioningEnabled {
				writeSyntheticS3XML(writer, `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>`)
			} else {
				writeSyntheticS3XML(writer, `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></VersioningConfiguration>`)
			}
		case "get-cors":
			writeSyntheticS3XML(writer, `<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><CORSRule><AllowedOrigin>https://duallane.tsio.top</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><ExposeHeader>Content-Length</ExposeHeader><ExposeHeader>Content-Type</ExposeHeader><MaxAgeSeconds>300</MaxAgeSeconds></CORSRule></CORSConfiguration>`)
		case "get-lifecycle":
			writeSyntheticS3XML(writer, `<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Rule><ID>abort-incomplete-multipart-after-7-days</ID><Status>Enabled</Status><Prefix></Prefix><AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule></LifecycleConfiguration>`)
		default:
			http.Error(writer, "synthetic operation failure", http.StatusBadRequest)
		}
	}))
	defer server.Close()

	config := testS3ProvisionConfig()
	config.Endpoint = server.URL
	client, err := newS3ProvisionClient(config)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := provisionS3Bucket(context.Background(), config, false, client)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Status != "planned" || plan.Versioning != "" || len(requests) == 0 {
		t.Fatalf("synthetic HTTP plan=%+v requests=%v", plan, requests)
	}
	for _, observed := range requests {
		if strings.HasPrefix(observed.operation, "put-") || strings.HasPrefix(observed.operation, "create-") || strings.HasPrefix(observed.operation, "abort-") {
			t.Fatalf("plan issued mutating S3 request: %v", requests)
		}
	}

	requests = nil
	report, err := provisionS3Bucket(context.Background(), config, true, client)
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "completed" || report.PrivatePolicy != "verified" || report.Versioning != string(s3types.BucketVersioningStatusEnabled) || report.CorsMode != "bucket" || report.MultipartCleanupMode != "bucket" {
		t.Fatalf("synthetic HTTP apply=%+v requests=%v", report, requests)
	}
	wantOperations := []string{"head", "get-policy", "put-versioning", "put-cors", "put-lifecycle", "get-versioning", "get-cors", "get-lifecycle", "get-policy"}
	if len(requests) != len(wantOperations) {
		t.Fatalf("synthetic HTTP operations=%v want=%v", requests, wantOperations)
	}
	for index, want := range wantOperations {
		if requests[index].operation != want {
			t.Fatalf("synthetic HTTP operation[%d]=%q want=%q", index, requests[index].operation, want)
		}
	}
	var corsBody, lifecycleBody string
	for _, observed := range requests {
		switch observed.operation {
		case "put-cors":
			corsBody = observed.body
		case "put-lifecycle":
			lifecycleBody = observed.body
		}
	}
	if !strings.Contains(corsBody, "<AllowedOrigin>https://duallane.tsio.top</AllowedOrigin>") || !strings.Contains(corsBody, "<AllowedMethod>GET</AllowedMethod>") || !strings.Contains(corsBody, "<AllowedMethod>HEAD</AllowedMethod>") || !strings.Contains(corsBody, "<AllowedHeader>*</AllowedHeader>") {
		t.Fatalf("synthetic CORS request did not preserve Node contract: %s", corsBody)
	}
	if !strings.Contains(lifecycleBody, "<Prefix></Prefix>") || !strings.Contains(lifecycleBody, "<DaysAfterInitiation>7</DaysAfterInitiation>") {
		t.Fatalf("synthetic lifecycle request did not preserve Node contract: %s", lifecycleBody)
	}
}

func syntheticS3Operation(request *http.Request) string {
	query := request.URL.Query()
	if request.Method == http.MethodHead {
		return "head"
	}
	if request.Method == http.MethodGet {
		switch {
		case query.Has("policy"):
			return "get-policy"
		case query.Has("versioning"):
			return "get-versioning"
		case query.Has("cors"):
			return "get-cors"
		case query.Has("lifecycle"):
			return "get-lifecycle"
		}
	}
	if request.Method == http.MethodPut {
		switch {
		case query.Has("versioning"):
			return "put-versioning"
		case query.Has("cors"):
			return "put-cors"
		case query.Has("lifecycle"):
			return "put-lifecycle"
		}
	}
	return request.Method + "-unknown"
}

func writeSyntheticS3XML(writer http.ResponseWriter, body string) {
	writer.Header().Set("Content-Type", "application/xml")
	writer.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(writer, body)
}

func TestS3ProvisionConfigRejectsSensitiveURLsAndInvalidOrigin(t *testing.T) {
	for _, value := range []s3ProvisionConfig{
		{Endpoint: "https://user:pass@s3.internal", Region: "us-east-1", Bucket: "duallane", AccessKey: "a", SecretKey: "b", AppOrigin: "https://duallane.tsio.top"},
		{Endpoint: "https://s3.internal/?token=secret", Region: "us-east-1", Bucket: "duallane", AccessKey: "a", SecretKey: "b", AppOrigin: "https://duallane.tsio.top"},
		{Endpoint: "http://s3.internal", Region: "us-east-1", Bucket: "duallane", AccessKey: "a", SecretKey: "b", AppOrigin: "http://duallane.tsio.top"},
	} {
		_, err := normalizeS3ProvisionConfig(value)
		if err == nil || !strings.Contains(err.Error(), "storage.provision_config_invalid") || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "s3.internal") {
			t.Fatalf("config error=%v", err)
		}
	}
}

func TestS3ProvisionErrorsDoNotExposeProviderDetails(t *testing.T) {
	fake := &provisionFakeAPI{headErr: apiRawError{message: "endpoint=https://s3.internal:9000/?token=secret accessKey=secret"}}
	_, err := provisionS3Bucket(context.Background(), testS3ProvisionConfig(), false, fake)
	if err == nil || s3ProvisionErrorCode(err) != "storage.provision_bucket_unavailable" {
		t.Fatalf("err=%v code=%q", err, s3ProvisionErrorCode(err))
	}
	if strings.Contains(err.Error(), "s3.internal") || strings.Contains(err.Error(), "secret") {
		t.Fatalf("provider details leaked: %v", err)
	}
}

func TestS3ProvisionCommandEmitsSafePartialReportWithoutRollback(t *testing.T) {
	credentialsPath := filepath.Join(t.TempDir(), "credentials.json")
	if err := os.WriteFile(credentialsPath, []byte(`{"accessKey":"synthetic-access","secretKey":"synthetic-secret"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	fake := &provisionFakeAPI{putCorsErr: apiRawError{message: "endpoint=https://s3.internal:9000/?token=secret"}}
	args := []string{
		"--s3-endpoint", "http://s3.internal:9000",
		"--s3-region", "us-east-1",
		"--s3-bucket", "duallane",
		"--s3-credentials-file", credentialsPath,
		"--public-base-url", "https://duallane.tsio.top",
		"--apply",
	}
	var output strings.Builder
	err := runProvisionWithClient(args, &output, &output, fake)
	if s3ProvisionErrorCode(err) != "storage.provision_cors_failed" {
		t.Fatalf("code=%q err=%v", s3ProvisionErrorCode(err), err)
	}
	report := mustDecodeReport(t, output.String())
	if report.Status != "partial" || report.PrivatePolicy != "verified" || report.Versioning == string(s3types.BucketVersioningStatusEnabled) || len(report.Actions) != 1 || report.Actions[0].Name != "versioning" || report.Actions[0].Outcome != "configured" {
		t.Fatalf("partial report=%+v", report)
	}
	if strings.Contains(output.String(), "s3.internal") || strings.Contains(output.String(), "secret") {
		t.Fatalf("partial report leaked provider details: %s", output.String())
	}
}

func TestS3PolicyPublicPrincipalShapes(t *testing.T) {
	for _, policy := range []string{
		`{"Statement":[{"Effect":"Allow","Principal":{"AWS":"*"}}]}`,
		`{"Statement":[{"Effect":"Allow","Principal":{"Service":["internal","*"]}}]}`,
	} {
		public, err := s3PolicyIsPublic(policy)
		if err != nil || !public {
			t.Fatalf("policy public=%t err=%v", public, err)
		}
	}
	private, err := s3PolicyIsPublic(`{"Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::123:role/private"}}]}`)
	if err != nil || private {
		t.Fatalf("private policy public=%t err=%v", private, err)
	}
}

func TestS3LifecycleMatchesProviderEmptyFilter(t *testing.T) {
	rule := s3types.LifecycleRule{
		ID:                             aws.String("abort-incomplete-multipart-after-7-days"),
		Status:                         s3types.ExpirationStatusEnabled,
		AbortIncompleteMultipartUpload: &s3types.AbortIncompleteMultipartUpload{DaysAfterInitiation: aws.Int32(s3ProvisionMultipartAbortDays)},
		Filter:                         &s3types.LifecycleRuleFilter{},
	}
	other := s3types.LifecycleRule{ID: aws.String("application-owned-rule"), Status: s3types.ExpirationStatusEnabled}
	if !s3LifecycleMatches([]s3types.LifecycleRule{other, rule}) {
		t.Fatal("empty provider filter should retain the all-object Node lifecycle contract")
	}
}

type apiCodeError struct{ code string }

func (e apiCodeError) Error() string     { return e.code }
func (e apiCodeError) ErrorCode() string { return e.code }

type apiRawError struct{ message string }

func (e apiRawError) Error() string { return e.message }

func containsCommand(commands []string, want string) bool { return countCommand(commands, want) > 0 }
func countCommand(commands []string, want string) int {
	count := 0
	for _, command := range commands {
		if command == want {
			count++
		}
	}
	return count
}

func mustDecodeReport(t *testing.T, value string) s3ProvisionReport {
	t.Helper()
	var report s3ProvisionReport
	if err := json.Unmarshal([]byte(value), &report); err != nil {
		t.Fatal(err)
	}
	return report
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
