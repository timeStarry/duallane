package main

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/carddefinitions"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/delivery"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/releases"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/runtime"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/email"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messagejobs"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/ntfy"
)

const (
	// Echo delivery has three independent queues. A small page keeps a busy
	// family from monopolizing one worker cycle while the delivery service's
	// own 30-second operation deadline remains the upper bound.
	echoWorkerInterval         = 30 * time.Second
	echoWorkerBatchLimit       = 25
	echoWorkerRequirementLimit = 25

	echoSolicitationProcessorName = "echo_solicitation_delivery"
	echoRequirementProcessorName  = "echo_requirement_delivery"
	echoReleaseProcessorName      = "echo_release_delivery"

	echoMemberReconciliationProcessorName = "echo_member_reconciliation"
	echoMemberReconciliationLimit         = 25
	echoMemberReconciliationTimeout       = 15 * time.Second
)

// echoDeliveryProcessor is deliberately narrower than the concrete service so
// cursor, error, and cancellation behavior can be tested without replacing
// the real delivery composition.
type echoDeliveryProcessor interface {
	ProcessJobsWithOptions(context.Context, delivery.ProcessOptions) (delivery.ProcessReport, error)
}

var _ echoDeliveryProcessor = (*delivery.Service)(nil)

// echoMemberSource is deliberately separate from delivery.Repository. The
// worker needs a bounded keyset scan; the domain repository's full membership
// listing is intentionally not used for a recovery page.
type echoMemberSource interface {
	ListActiveHumanMembersAfter(context.Context, string, string, int) ([]string, error)
}

type echoMemberReconciler interface {
	SyncMember(context.Context, string, string, auth.RequestMeta) (delivery.MemberSyncResult, error)
}

var _ echoMemberReconciler = (*delivery.Service)(nil)

type echoPGMemberSource struct {
	pool *pgxpool.Pool
}

func (s *echoPGMemberSource) ListActiveHumanMembersAfter(ctx context.Context, spaceID, afterID string, limit int) ([]string, error) {
	if s == nil || s.pool == nil {
		return nil, errors.New("echo member PostgreSQL pool is required")
	}
	if ctx == nil {
		return nil, errors.New("echo member context is required")
	}
	limit = echoMemberPageLimit(limit)
	rows, err := s.pool.Query(ctx, `
SELECT sm.user_id
FROM space_members sm
INNER JOIN users u ON u.id = sm.user_id
WHERE sm.space_id = $1
  AND sm.user_id > $2
  AND sm.removed_at IS NULL
  AND u.kind = 'human'
ORDER BY sm.user_id ASC
LIMIT $3`, spaceID, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	members := make([]string, 0, limit)
	for rows.Next() {
		var memberID string
		if err := rows.Scan(&memberID); err != nil {
			return nil, err
		}
		members = append(members, memberID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return members, nil
}

func echoMemberPageLimit(limit int) int {
	if limit <= 0 || limit > echoMemberReconciliationLimit {
		return echoMemberReconciliationLimit
	}
	return limit
}

// echoCursorState is owned by exactly one workerProcessor closure. It is
// process-local scheduling state only; delivery status, claims, and idempotent
// effects remain durable in PostgreSQL.
type echoCursorState struct {
	mu    sync.Mutex
	value string
}

// newEchoProcessors composes the real Echo delivery runtime for the worker.
// The parent process owns when this function is called and whether the
// returned processors are appended to application.processors. No provider
// worker is started here and no external notification is sent here.
//
// The exact parent-facing signature is:
//
//	newEchoProcessors(pool *pgxpool.Pool, runtimeConfig *config.WorkspaceConfig) ([]workerProcessor, error)
func newEchoProcessors(pool *pgxpool.Pool, runtimeConfig *config.WorkspaceConfig) ([]workerProcessor, error) {
	if runtimeConfig == nil {
		return nil, errors.New("echo worker configuration is required")
	}
	if !runtimeConfig.Enabled {
		return nil, nil
	}
	if pool == nil {
		return nil, errors.New("echo worker PostgreSQL pool is required")
	}

	spaceID := delivery.DefaultSpaceID
	frontendURL := runtimeConfig.FrontendURL
	if frontendURL == "" {
		frontendURL = runtimeConfig.PublicBaseURL
	}

	// The scheduler is the same durable message-jobs composition used by
	// ordinary Workspace message writes. Construction only binds repositories;
	// provider I/O remains in the separately configured notification workers.
	emailRepository := email.NewPGRepository(pool)
	emailService, err := email.NewServiceWithError(email.ServiceOptions{
		Repository:       emailRepository,
		SpaceID:          spaceID,
		FrontendURL:      frontendURL,
		EncryptionKeyB64: runtimeConfig.SMTPEncryptionKey,
	})
	if err != nil {
		return nil, err
	}
	ntfyRepository := ntfy.NewPGRepository(pool)
	ntfyService, err := ntfy.NewServiceWithError(ntfy.ServiceOptions{
		Repository:  ntfyRepository,
		ServerURL:   runtimeConfig.NtfyBaseURL,
		FrontendURL: frontendURL,
		SpaceID:     spaceID,
	})
	if err != nil {
		return nil, err
	}
	scheduler := messagejobs.NewScheduler(emailService, emailRepository, ntfyService, ntfyRepository)
	messagesRepository := messages.NewPGRepositoryWithMessageJobs(pool, scheduler)

	cardsRepository := cards.NewPGRepository(pool)
	registry, err := carddefinitions.NewRegistry(carddefinitions.Options{})
	if err != nil {
		return nil, err
	}
	cardService := cards.NewService(cards.ServiceOptions{
		Repository: cardsRepository,
		Registry:   registry,
		SpaceID:    spaceID,
	})

	requirementsRepository := requirements.NewPGRepository(pool)
	requirementsService := requirements.NewService(requirements.ServiceOptions{
		Repository: requirementsRepository,
		SpaceID:    spaceID,
	})
	solicitationsRepository := solicitations.NewPGRepository(pool)
	solicitationsService := solicitations.NewService(solicitations.ServiceOptions{
		Repository:         solicitationsRepository,
		SpaceID:            spaceID,
		ConversationAccess: messagesRepository,
		Requirements:       requirementsService,
	})
	releasesRepository := releases.NewPGRepository(pool)
	releasesService, err := releases.NewServiceFromCatalogFile(
		releases.ServiceOptions{Repository: releasesRepository, SpaceID: spaceID},
		runtimeConfig.ReleaseCatalogPath,
	)
	if err != nil {
		return nil, err
	}

	deliveryService, err := runtime.NewDeliveryService(runtime.DeliveryOptions{
		Pool:          pool,
		SpaceID:       spaceID,
		Messages:      messagesRepository,
		Cards:         cardsRepository,
		CardService:   cardService,
		Requirements:  requirementsService,
		Solicitations: solicitationsService,
		Releases:      releasesService,
	})
	if err != nil {
		return nil, err
	}

	return []workerProcessor{
		newEchoProcessor(echoSolicitationProcessorName, delivery.DeliveryTypeSolicitation, deliveryService),
		newEchoProcessor(echoRequirementProcessorName, delivery.DeliveryTypeRequirement, deliveryService),
		newEchoProcessor(echoReleaseProcessorName, delivery.DeliveryTypeRelease, deliveryService),
		newEchoMemberReconciliationProcessor(
			echoMemberReconciliationProcessorName,
			spaceID,
			&echoPGMemberSource{pool: pool},
			deliveryService,
		),
	}, nil
}

func newEchoProcessor(name, family string, service echoDeliveryProcessor) workerProcessor {
	state := &echoCursorState{}
	return workerProcessor{
		name:     name,
		interval: echoWorkerInterval,
		process: func(ctx context.Context) (processResult, error) {
			state.mu.Lock()
			defer state.mu.Unlock()

			report, err := service.ProcessJobsWithOptions(ctx, delivery.ProcessOptions{
				Limit:            echoWorkerBatchLimit,
				RequirementLimit: echoWorkerRequirementLimit,
				Cursor:           echoCursorForFamily(family, state.value),
				Family:           family,
			})
			cancelled := echoProcessCancelled(ctx, err)
			// ProcessJobsWithOptions may return a partial Next cursor together
			// with a row or infrastructure error. Treat every error report as
			// uncommitted so the next cycle retries from the prior checkpoint.
			if err == nil && !cancelled {
				state.value = echoCursorValue(report.Next, family)
			}
			return echoProcessResult(report, family, cancelled), err
		},
	}
}

func newEchoMemberReconciliationProcessor(name, spaceID string, source echoMemberSource, service echoMemberReconciler) workerProcessor {
	return newEchoMemberReconciliationProcessorWithTimeout(
		name, spaceID, source, service, echoMemberReconciliationTimeout,
	)
}

func newEchoMemberReconciliationProcessorWithTimeout(name, spaceID string, source echoMemberSource, service echoMemberReconciler, timeout time.Duration) workerProcessor {
	if timeout <= 0 {
		timeout = echoMemberReconciliationTimeout
	}
	state := &echoCursorState{}
	return workerProcessor{
		name:     name,
		interval: echoWorkerInterval,
		process: func(ctx context.Context) (processResult, error) {
			state.mu.Lock()
			defer state.mu.Unlock()

			if source == nil {
				return processResult{}, errors.New("echo member source is required")
			}
			if service == nil {
				return processResult{}, errors.New("echo member reconciliation service is required")
			}
			if ctx == nil {
				ctx = context.Background()
			}
			cycleCtx, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()

			members, err := source.ListActiveHumanMembersAfter(
				cycleCtx, spaceID, state.value, echoMemberReconciliationLimit,
			)
			if err != nil {
				cancelled := echoProcessCancelled(ctx, err) || cycleCtx.Err() != nil
				result := processResult{}
				if cancelled {
					result.Cancelled = 1
				}
				return result, err
			}

			pageFull := len(members) >= echoMemberReconciliationLimit
			if len(members) > echoMemberReconciliationLimit {
				// The production source already enforces this bound. Keep the
				// worker safe if a test double or future source violates it.
				members = members[:echoMemberReconciliationLimit]
			}
			result := processResult{}
			var firstErr error
			for _, memberID := range members {
				if err := cycleCtx.Err(); err != nil {
					firstErr = err
					break
				}
				result.Claimed++
				syncResult, syncErr := service.SyncMember(cycleCtx, spaceID, memberID, auth.RequestMeta{})
				addEchoMemberSyncResult(&result, syncResult)
				if syncErr != nil {
					if echoProcessCancelled(ctx, syncErr) || cycleCtx.Err() != nil {
						firstErr = syncErr
						break
					}
					// Keep trying the remainder of this bounded page. A single
					// dependency failure must not starve later members; the page
					// remains uncommitted and is retried on a later cycle.
					result.Failed++
					if firstErr == nil {
						firstErr = syncErr
					}
					continue
				}
				if err := cycleCtx.Err(); err != nil {
					firstErr = err
					break
				}
			}
			if firstErr == nil {
				firstErr = cycleCtx.Err()
			}
			cancelled := echoProcessCancelled(ctx, firstErr) || cycleCtx.Err() != nil
			if cancelled {
				result.Cancelled = 1
			}
			// A cursor is a durable scheduling checkpoint only after every
			// member attempt in this page completed successfully. This mirrors
			// the three delivery-family processors and prevents an ordinary
			// error from silently dropping a member page.
			if firstErr == nil && !cancelled {
				if !pageFull || len(members) == 0 {
					state.value = ""
				} else {
					state.value = members[len(members)-1]
				}
			}
			return result, firstErr
		},
	}
}

func echoCursorForFamily(family, value string) delivery.WorkCursor {
	switch family {
	case delivery.DeliveryTypeSolicitation:
		return delivery.WorkCursor{Solicitation: value}
	case delivery.DeliveryTypeRequirement:
		return delivery.WorkCursor{Requirement: value}
	case delivery.DeliveryTypeRelease:
		return delivery.WorkCursor{Release: value}
	default:
		return delivery.WorkCursor{}
	}
}

func echoCursorValue(cursor delivery.WorkCursor, family string) string {
	switch family {
	case delivery.DeliveryTypeSolicitation:
		return cursor.Solicitation
	case delivery.DeliveryTypeRequirement:
		return cursor.Requirement
	case delivery.DeliveryTypeRelease:
		return cursor.Release
	default:
		return ""
	}
}

func echoProcessCancelled(ctx context.Context, err error) bool {
	if ctx != nil && ctx.Err() != nil {
		return true
	}
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

// echoProcessResult intentionally projects only bounded counters. Delivery
// IDs, recipients, card IDs, message IDs, error codes, and any card payload
// are not copied into worker results or logs.
func echoProcessResult(report delivery.ProcessReport, family string, cancelled bool) processResult {
	result := processResult{}
	switch family {
	case delivery.DeliveryTypeSolicitation:
		result.Claimed = len(report.Solicitations)
		for _, item := range report.Solicitations {
			addEchoStatus(&result, item.Status)
		}
	case delivery.DeliveryTypeRequirement:
		result.Claimed = len(report.Requirements)
		for _, summary := range report.Requirements {
			result.Sent += summary.Sent
			result.Failed += summary.Failed
		}
	case delivery.DeliveryTypeRelease:
		result.Claimed = len(report.Releases)
		for _, item := range report.Releases {
			addEchoStatus(&result, item.Status)
		}
	}
	if cancelled {
		result.Cancelled = 1
	}
	return result
}

func addEchoStatus(result *processResult, status string) {
	if result == nil {
		return
	}
	switch status {
	case delivery.DeliverySent:
		result.Sent++
	case delivery.DeliveryFailed:
		result.Failed++
	}
}

func addEchoMemberSyncResult(result *processResult, report delivery.MemberSyncResult) {
	if result == nil {
		return
	}
	for _, item := range report.Solicitations {
		addEchoStatus(result, item.Status)
	}
	for _, item := range report.Requirements {
		addEchoStatus(result, item.Status)
	}
	// SyncMember intentionally has no release delivery path. Do not turn a
	// future/debug-only Releases field into a second release publisher.
}
