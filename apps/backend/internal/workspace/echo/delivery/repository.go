package delivery

import (
	"context"
	"time"
)

// Repository is the delivery domain's deliberately narrow storage seam. Echo
// owns delivery rows; users, membership, conversations, cards and messages are
// accessed only through the explicit authorization/domain methods below.
type Repository interface {
	WithTx(context.Context, func(Tx) error) error

	GetSolicitation(context.Context, string, string) (*SolicitationDelivery, error)
	GetSolicitationByID(context.Context, string, string) (*SolicitationDelivery, error)
	ListSolicitationDeliveries(context.Context, string, string, string, int) ([]SolicitationDelivery, error)
	ListSolicitationWork(context.Context, string, string, int) ([]SolicitationDelivery, error)
	EnsureSolicitationDeliveryRows(context.Context, string, string, time.Time) error
	EnsureSolicitationDeliveryRowsForMember(context.Context, string, string, time.Time) error

	GetRequirement(context.Context, string, string) (*RequirementRecord, error)
	ListRequirementsForRecovery(context.Context, string, string, int) ([]RequirementRecord, error)
	ListRequirementsForMember(context.Context, string, string, bool, int) ([]RequirementRecord, error)

	GetReleaseDelivery(context.Context, string, string) (*ReleaseDelivery, error)
	ListReleaseDeliveries(context.Context, string, string, string, int) ([]ReleaseDelivery, error)
	ListReleaseWork(context.Context, string, string, int) ([]ReleaseDelivery, error)

	IsActiveHumanMember(context.Context, string, string) (bool, error)
	ListActiveHumanMembers(context.Context, string) ([]string, error)
	ListActiveOwners(context.Context, string) ([]string, error)
	FindCard(context.Context, string, string, string) (*ExistingCard, error)
}

// Tx is the accepting transaction. Claim methods use PostgreSQL row locks
// with SKIP LOCKED; all card/message writes made by EchoWriter and all
// delivery/audit/event writes happen through this same object.
type Tx interface {
	ClaimSolicitationDelivery(context.Context, string, string) (*SolicitationDelivery, bool, error)
	ClaimReleaseDelivery(context.Context, string, string) (*ReleaseDelivery, bool, error)
	GetSolicitation(context.Context, string, string) (*SolicitationDelivery, error)
	GetRequirement(context.Context, string, string) (*RequirementRecord, error)
	FindCard(context.Context, string, string, string) (*ExistingCard, error)
	ListActiveHumanMembers(context.Context, string) ([]string, error)
	IsActiveHumanMember(context.Context, string, string) (bool, error)
	EchoIdentityActive(context.Context, string) (bool, error)
	RequirementRecipientAuthorized(context.Context, string, string, string, string) (bool, error)
	EnsureEchoDirectConversation(context.Context, string, string, string, time.Time) (*DirectConversation, error)
	MarkSolicitationDelivery(context.Context, string, string, string, string, time.Time) error
	MarkReleaseDelivery(context.Context, string, string, string, string, time.Time) error
	Lock(context.Context, string) error
	WriteAudit(context.Context, AuditInput) error
	WriteEvent(context.Context, EventInput) error
}

var _ Repository = (*PGRepository)(nil)
