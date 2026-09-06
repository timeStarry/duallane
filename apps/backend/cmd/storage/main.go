package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/storageops"
)

const (
	defaultVerifyTimeout = 30 * time.Second
	maximumVerifyTimeout = 5 * time.Minute
	syntheticTarget      = "synthetic"
	postgresTarget       = "postgres"
	defaultPoolMax       = 2
)

var safeSchemaName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,62}$`)

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		writeUsage(stderr)
		return errors.New("storageops.command_required")
	}
	switch args[0] {
	case "plan":
		return runPlan(args[1:], stdout, stderr)
	case "verify":
		return runVerify(args[1:], stdout, stderr)
	default:
		writeUsage(stderr)
		return errors.New("storageops.command_invalid")
	}
}

func runPlan(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("storage plan", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	manifestPath := flags.String("manifest", "", "private operator manifest JSON")
	operation := flags.String("operation", "verify", "read-only operation to plan")
	target := flags.String("target", syntheticTarget, "execution target: synthetic or postgres")
	databaseURL := flags.String("database-url", "", "PostgreSQL DSN; defaults to DATABASE_URL")
	migrationsDir := flags.String("migrations-dir", strings.TrimSpace(os.Getenv(config.WorkspaceMigrationsDirEnv)), "migration directory; defaults to DUALLANE_MIGRATIONS_DIR")
	databaseSchema := flags.String("schema", "", "optional PostgreSQL schema/search_path")
	poolMax := flags.Int("pool-max", defaultPoolMax, "bounded PostgreSQL pool size")
	spaceID := flags.String("space-id", storageops.DefaultWorkspaceSpaceID, "Workspace space used for quota evidence")
	dailyQuota := flags.Int64("daily-quota-bytes", storageops.DefaultDailyQuotaBytes, "daily upload quota used for read-only evidence")
	runID := flags.String("run-id", defaultRunID(), "operator snapshot run identifier")
	nowValue := flags.String("now", "", "RFC3339 time used for deterministic backup checks")
	apply := flags.Bool("apply", false, "reserved for mutating phases; rejected by this read-only command")
	if err := flags.Parse(args); err != nil {
		writeUsage(stderr)
		return errors.New("storageops.flags_invalid")
	}
	if flags.NArg() != 0 {
		return errors.New("storageops.flags_invalid")
	}
	if strings.TrimSpace(*databaseURL) == "" {
		*databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if *apply {
		return storageops.ErrReadOnlyTarget
	}
	if *target != syntheticTarget && *target != postgresTarget {
		return storageops.ErrReadOnlyTarget
	}
	now, err := parseOptionalTime(*nowValue)
	if err != nil {
		return err
	}
	var manifest storageops.Manifest
	if *target == syntheticTarget {
		manifest, err = loadManifestArgument(*manifestPath)
	} else {
		if strings.TrimSpace(*manifestPath) != "" {
			return errors.New("storageops.manifest_not_allowed_with_database")
		}
		ctx, cancel := signalContext(defaultVerifyTimeout)
		defer cancel()
		manifest, err = snapshotFromPostgres(ctx, postgresSnapshotInput{
			databaseURL: *databaseURL, migrationsDir: *migrationsDir, schema: *databaseSchema,
			poolMax: *poolMax, spaceID: *spaceID, dailyQuota: *dailyQuota, runID: *runID,
		})
	}
	if err != nil {
		return err
	}
	report, err := storageops.BuildPlan(manifest, storageops.PlanOptions{Operation: *operation, Now: now})
	if err != nil {
		return err
	}
	if err := writeJSON(stdout, report); err != nil {
		return err
	}
	if report.Status != "ready" {
		return storageops.ErrInvalidManifest
	}
	return nil
}

func runVerify(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("storage verify", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	manifestPath := flags.String("manifest", "", "private operator manifest JSON")
	objectRoot := flags.String("object-root", "", "existing local object-store root")
	target := flags.String("target", syntheticTarget, "execution target: synthetic or postgres")
	storeKind := flags.String("store", string(storageops.ReadOnlyLocalStore), "read-only object store: local or s3")
	databaseURL := flags.String("database-url", "", "PostgreSQL DSN; defaults to DATABASE_URL")
	migrationsDir := flags.String("migrations-dir", strings.TrimSpace(os.Getenv(config.WorkspaceMigrationsDirEnv)), "migration directory; defaults to DUALLANE_MIGRATIONS_DIR")
	databaseSchema := flags.String("schema", "", "optional PostgreSQL schema/search_path")
	poolMax := flags.Int("pool-max", defaultPoolMax, "bounded PostgreSQL pool size")
	spaceID := flags.String("space-id", storageops.DefaultWorkspaceSpaceID, "Workspace space used for quota evidence")
	dailyQuota := flags.Int64("daily-quota-bytes", storageops.DefaultDailyQuotaBytes, "daily upload quota used for read-only evidence")
	runID := flags.String("run-id", defaultRunID(), "operator snapshot run identifier")
	s3Endpoint := flags.String("s3-endpoint", strings.TrimSpace(os.Getenv(config.WorkspaceS3EndpointEnv)), "private S3-compatible endpoint")
	s3Region := flags.String("s3-region", strings.TrimSpace(os.Getenv(config.WorkspaceS3RegionEnv)), "private S3 region")
	s3Bucket := flags.String("s3-bucket", strings.TrimSpace(os.Getenv(config.WorkspaceS3BucketEnv)), "private S3 bucket")
	s3CredentialsFile := flags.String("s3-credentials-file", strings.TrimSpace(os.Getenv(config.WorkspaceS3CredentialsFileEnv)), "private S3 credentials JSON file")
	timeout := flags.Duration("timeout", defaultVerifyTimeout, "bounded verification deadline")
	nowValue := flags.String("now", "", "RFC3339 time used for deterministic backup checks")
	apply := flags.Bool("apply", false, "reserved for mutating phases; rejected by this read-only command")
	if err := flags.Parse(args); err != nil {
		writeUsage(stderr)
		return errors.New("storageops.flags_invalid")
	}
	if flags.NArg() != 0 {
		return errors.New("storageops.flags_invalid")
	}
	if strings.TrimSpace(*databaseURL) == "" {
		*databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if *apply {
		return storageops.ErrReadOnlyTarget
	}
	if *target != syntheticTarget && *target != postgresTarget {
		return storageops.ErrReadOnlyTarget
	}
	if *target == syntheticTarget && strings.TrimSpace(*storeKind) != string(storageops.ReadOnlyLocalStore) {
		return errors.New("storageops.synthetic_store_invalid")
	}
	if *timeout <= 0 || *timeout > maximumVerifyTimeout {
		return errors.New("storageops.verify_timeout_invalid")
	}
	now, err := parseOptionalTime(*nowValue)
	if err != nil {
		return err
	}
	ctx, cancel := signalContext(*timeout)
	defer cancel()
	var manifest storageops.Manifest
	if *target == syntheticTarget {
		manifest, err = loadManifestArgument(*manifestPath)
	} else {
		if strings.TrimSpace(*manifestPath) != "" {
			return errors.New("storageops.manifest_not_allowed_with_database")
		}
		manifest, err = snapshotFromPostgres(ctx, postgresSnapshotInput{
			databaseURL: *databaseURL, migrationsDir: *migrationsDir, schema: *databaseSchema,
			poolMax: *poolMax, spaceID: *spaceID, dailyQuota: *dailyQuota, runID: *runID,
		})
	}
	if err != nil {
		return err
	}
	storeOptions, err := readOnlyStoreOptions(*storeKind, *objectRoot, *s3Endpoint, *s3Region, *s3Bucket, *s3CredentialsFile)
	if err != nil {
		return err
	}
	store, err := storageops.OpenReadOnlyStore(ctx, storeOptions)
	if err != nil {
		return err
	}
	defer store.Close()
	report, verifyErr := storageops.Verify(ctx, manifest, storageops.VerifyOptions{Store: store, Now: now})
	if err := writeJSON(stdout, report); err != nil {
		return err
	}
	return verifyErr
}

func loadManifestArgument(path string) (storageops.Manifest, error) {
	if strings.TrimSpace(path) == "" {
		return storageops.Manifest{}, errors.New("storageops.manifest_required")
	}
	return storageops.LoadManifest(path)
}

func parseOptionalTime(value string) (time.Time, error) {
	if strings.TrimSpace(value) == "" {
		return time.Time{}, nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, errors.New("storageops.time_invalid")
	}
	return parsed.UTC(), nil
}

func signalContext(timeout time.Duration) (context.Context, context.CancelFunc) {
	root, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	ctx, cancel := context.WithTimeout(root, timeout)
	return ctx, func() { cancel(); stop() }
}

func writeJSON(writer io.Writer, value any) error {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func writeUsage(writer io.Writer) {
	_, _ = fmt.Fprintln(writer, "usage: storage <plan|verify> [flags]")
	_, _ = fmt.Fprintln(writer, "plan: read-only manifest or PostgreSQL schema/owner/quota/CAS/reference plan")
	_, _ = fmt.Fprintln(writer, "verify: read-only PostgreSQL snapshot plus local or S3 canonical-byte verification")
}

type postgresSnapshotInput struct {
	databaseURL   string
	migrationsDir string
	schema        string
	poolMax       int
	spaceID       string
	dailyQuota    int64
	runID         string
}

func snapshotFromPostgres(ctx context.Context, input postgresSnapshotInput) (storageops.Manifest, error) {
	expected, err := storageops.ReadExpectedMigrations(input.migrationsDir)
	if err != nil {
		return storageops.Manifest{}, err
	}
	pool, err := openOperatorPool(ctx, input.databaseURL, input.schema, input.poolMax)
	if err != nil {
		return storageops.Manifest{}, err
	}
	defer pool.Close()
	source, err := storageops.NewPostgresSnapshotSource(pool, storageops.PostgresSnapshotOptions{
		ExpectedMigrations: expected,
		SpaceID:            input.spaceID,
		DailyQuotaBytes:    input.dailyQuota,
	})
	if err != nil {
		return storageops.Manifest{}, err
	}
	return source.Snapshot(ctx, storageops.SnapshotRequest{RunID: strings.TrimSpace(input.runID)})
}

func openOperatorPool(ctx context.Context, databaseURL, schema string, maxConnections int) (*pgxpool.Pool, error) {
	if strings.TrimSpace(databaseURL) == "" {
		return nil, errors.New("storageops.database_url_required")
	}
	if maxConnections < 1 || maxConnections > int(postgres.MaximumPoolConnections) {
		return nil, errors.New("storageops.pool_max_invalid")
	}
	poolConfig, err := postgres.PoolConfig(databaseURL, postgres.PoolOptions{MaxConnections: int32(maxConnections)})
	if err != nil {
		return nil, errors.New("storageops.database_unavailable")
	}
	if strings.TrimSpace(schema) != "" {
		if !safeSchemaName.MatchString(strings.TrimSpace(schema)) {
			return nil, errors.New("storageops.schema_invalid")
		}
		poolConfig.ConnConfig.RuntimeParams["search_path"] = pgx.Identifier{strings.TrimSpace(schema)}.Sanitize()
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, errors.New("storageops.database_unavailable")
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, errors.New("storageops.database_unavailable")
	}
	return pool, nil
}

func readOnlyStoreOptions(kind, objectRoot, endpoint, region, bucket, credentialsFile string) (storageops.ReadOnlyStoreOptions, error) {
	kind = strings.ToLower(strings.TrimSpace(kind))
	if kind == string(storageops.ReadOnlyLocalStore) {
		if strings.TrimSpace(objectRoot) == "" {
			return storageops.ReadOnlyStoreOptions{}, errors.New("storageops.object_root_required")
		}
		return storageops.ReadOnlyStoreOptions{Kind: storageops.ReadOnlyLocalStore, ObjectRoot: objectRoot}, nil
	}
	if kind != string(storageops.ReadOnlyS3Store) {
		return storageops.ReadOnlyStoreOptions{}, errors.New("storageops.store_invalid")
	}
	credentials, err := config.LoadS3Credentials(credentialsFile)
	if err != nil {
		return storageops.ReadOnlyStoreOptions{}, errors.New("storageops.s3_credentials_unavailable")
	}
	return storageops.ReadOnlyStoreOptions{
		Kind: storageops.ReadOnlyS3Store,
		S3: storage.S3Config{
			Endpoint: endpoint, Region: region, Bucket: bucket,
			AccessKey: credentials.AccessKey, SecretKey: credentials.SecretKey,
		},
	}, nil
}

func defaultRunID() string {
	return fmt.Sprintf("storage-cli-%d", time.Now().UTC().Unix())
}
