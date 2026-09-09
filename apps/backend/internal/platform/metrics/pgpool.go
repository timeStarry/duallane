package metrics

import (
	"reflect"
	"time"
)

// PGPoolSnapshot is a read-only snapshot of a pgxpool-compatible pool.
// Values are normalized to non-negative gauges by SetPGPool.
type PGPoolSnapshot struct {
	MaxConns          int64
	TotalConns        int64
	AcquiredConns     int64
	IdleConns         int64
	ConstructingConns int64
	Cumulative        PGPoolCumulativeSnapshot
}

// PGPoolStats is implemented by pgxpool.Stat. Keeping this adapter structural
// avoids making the metrics package depend on the pool or its configuration.
type PGPoolStats interface {
	MaxConns() int32
	TotalConns() int32
	AcquiredConns() int32
	IdleConns() int32
	ConstructingConns() int32
}

// PGPoolCumulativeStats is the optional cumulative portion of pgxpool.Stat.
// It is kept separate from PGPoolStats so pool-compatible test doubles and
// older adapters can expose gauges without pretending cumulative values are
// zero.
type PGPoolCumulativeStats interface {
	AcquireCount() int64
	AcquireDuration() time.Duration
	CanceledAcquireCount() int64
	EmptyAcquireCount() int64
}

// PGPoolCumulativeSnapshot contains cumulative pool counters when the source
// exposes PGPoolCumulativeStats. Available distinguishes a real zero from a
// source that does not provide these methods.
type PGPoolCumulativeSnapshot struct {
	Available            bool
	AcquireCount         int64
	AcquireDuration      time.Duration
	CanceledAcquireCount int64
	EmptyAcquireCount    int64
}

type pgpoolCumulativeBaseline struct {
	initialized          bool
	acquireCount         int64
	acquireDuration      time.Duration
	canceledAcquireCount int64
	emptyAcquireCount    int64
}

// SnapshotFromPGPool converts a pool stat object without retaining it. A nil
// or typed-nil stat returns a zero snapshot.
func SnapshotFromPGPool(stats PGPoolStats) PGPoolSnapshot {
	if isNilValue(stats) {
		return PGPoolSnapshot{}
	}
	snapshot := PGPoolSnapshot{
		MaxConns:          int64(stats.MaxConns()),
		TotalConns:        int64(stats.TotalConns()),
		AcquiredConns:     int64(stats.AcquiredConns()),
		IdleConns:         int64(stats.IdleConns()),
		ConstructingConns: int64(stats.ConstructingConns()),
	}
	if cumulative, ok := stats.(PGPoolCumulativeStats); ok && !isNilValue(cumulative) {
		snapshot.Cumulative = PGPoolCumulativeSnapshot{
			Available:            true,
			AcquireCount:         cumulative.AcquireCount(),
			AcquireDuration:      cumulative.AcquireDuration(),
			CanceledAcquireCount: cumulative.CanceledAcquireCount(),
			EmptyAcquireCount:    cumulative.EmptyAcquireCount(),
		}
	}
	return snapshot
}

// PGPoolAcquireOutcome is a fixed category for a pool acquire attempt.
type PGPoolAcquireOutcome string

const (
	PGPoolAcquireSuccess  PGPoolAcquireOutcome = "success"
	PGPoolAcquireCanceled PGPoolAcquireOutcome = "canceled"
	PGPoolAcquireEmpty    PGPoolAcquireOutcome = "empty"
	PGPoolAcquireError    PGPoolAcquireOutcome = "error"
	PGPoolAcquireOther    PGPoolAcquireOutcome = "other"
)

// SetPGPool updates the safe pool gauges for a service.
func (m *Metrics) SetPGPool(service Service, snapshot PGPoolSnapshot) {
	if m == nil {
		return
	}
	serviceLabel := normalizeService(service)
	m.postgresPoolMax.WithLabelValues(serviceLabel).Set(nonNegativeFloat(snapshot.MaxConns))
	m.postgresPoolTotal.WithLabelValues(serviceLabel).Set(nonNegativeFloat(snapshot.TotalConns))
	m.postgresPoolAcquired.WithLabelValues(serviceLabel).Set(nonNegativeFloat(snapshot.AcquiredConns))
	m.postgresPoolIdle.WithLabelValues(serviceLabel).Set(nonNegativeFloat(snapshot.IdleConns))
	m.postgresPoolConstructing.WithLabelValues(serviceLabel).Set(nonNegativeFloat(snapshot.ConstructingConns))
	if snapshot.Cumulative.Available {
		m.setPGPoolCumulative(serviceLabel, snapshot.Cumulative)
	}
}

func (m *Metrics) setPGPoolCumulative(service string, current PGPoolCumulativeSnapshot) {
	current = normalizePGPoolCumulative(current)
	m.pgpoolMu.Lock()
	defer m.pgpoolMu.Unlock()
	if m.pgpoolCumulative == nil {
		m.pgpoolCumulative = make(map[string]pgpoolCumulativeBaseline)
	}
	previous := m.pgpoolCumulative[service]
	acquireCount, acquireDelta := highWatermarkDelta(current.AcquireCount, previous.acquireCount, previous.initialized)
	canceledAcquireCount, canceledDelta := highWatermarkDelta(current.CanceledAcquireCount, previous.canceledAcquireCount, previous.initialized)
	emptyAcquireCount, emptyDelta := highWatermarkDelta(current.EmptyAcquireCount, previous.emptyAcquireCount, previous.initialized)
	acquireDuration, durationDelta := highWatermarkDurationDelta(current.AcquireDuration, previous.acquireDuration, previous.initialized)
	m.pgpoolCumulative[service] = pgpoolCumulativeBaseline{
		initialized:          true,
		acquireCount:         acquireCount,
		acquireDuration:      acquireDuration,
		canceledAcquireCount: canceledAcquireCount,
		emptyAcquireCount:    emptyAcquireCount,
	}
	if acquireDelta > 0 {
		m.postgresPoolAcquires.WithLabelValues(service, string(PGPoolAcquireSuccess)).Add(float64(acquireDelta))
	}
	if canceledDelta > 0 {
		m.postgresPoolAcquires.WithLabelValues(service, string(PGPoolAcquireCanceled)).Add(float64(canceledDelta))
	}
	if emptyDelta > 0 {
		m.postgresPoolAcquires.WithLabelValues(service, string(PGPoolAcquireEmpty)).Add(float64(emptyDelta))
	}
	if durationDelta > 0 {
		m.postgresPoolAcquireDuration.WithLabelValues(service).Add(durationDelta.Seconds())
	}
}

func normalizePGPoolCumulative(value PGPoolCumulativeSnapshot) PGPoolCumulativeSnapshot {
	if value.AcquireCount < 0 {
		value.AcquireCount = 0
	}
	if value.AcquireDuration < 0 {
		value.AcquireDuration = 0
	}
	if value.CanceledAcquireCount < 0 {
		value.CanceledAcquireCount = 0
	}
	if value.EmptyAcquireCount < 0 {
		value.EmptyAcquireCount = 0
	}
	return value
}

// highWatermarkDelta treats a lower cumulative sample as stale. SetPGPool
// receives snapshots sampled outside its mutex, so a late sample from the
// same pool generation can arrive after a newer one. This package does not
// have a pool-generation signal; a reset therefore requires a new Metrics
// instance rather than interpreting a lower value as a reset.
func highWatermarkDelta(current, previous int64, initialized bool) (int64, int64) {
	if !initialized {
		return current, current
	}
	if current < previous {
		return previous, 0
	}
	return current, current - previous
}

func highWatermarkDurationDelta(current, previous time.Duration, initialized bool) (time.Duration, time.Duration) {
	if !initialized {
		return current, current
	}
	if current < previous {
		return previous, 0
	}
	return current, current - previous
}

// ObservePGPoolAcquire records a bounded outcome and wait duration. It accepts
// no error, DSN, query, or pool identifier, so failed acquires cannot leak raw
// infrastructure details into labels. Do not call it for success, canceled,
// or empty attempts that are also represented by SetPGPool cumulative stats;
// those two observation paths share the same counter and would double-count.
func (m *Metrics) ObservePGPoolAcquire(service Service, outcome PGPoolAcquireOutcome, wait time.Duration) {
	if m == nil {
		return
	}
	if wait < 0 {
		wait = 0
	}
	serviceLabel := normalizeService(service)
	outcomeLabel := normalizePGPoolAcquireOutcome(outcome)
	m.postgresPoolAcquires.WithLabelValues(serviceLabel, outcomeLabel).Inc()
	m.postgresPoolWait.WithLabelValues(serviceLabel).Observe(wait.Seconds())
}

func normalizePGPoolAcquireOutcome(value PGPoolAcquireOutcome) string {
	switch value {
	case PGPoolAcquireSuccess, PGPoolAcquireCanceled, PGPoolAcquireEmpty, PGPoolAcquireError:
		return string(value)
	default:
		return string(PGPoolAcquireOther)
	}
}

func nonNegativeFloat(value int64) float64 {
	if value < 0 {
		return 0
	}
	return float64(value)
}

func isNilValue(value any) bool {
	if value == nil {
		return true
	}
	rv := reflect.ValueOf(value)
	switch rv.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return rv.IsNil()
	default:
		return false
	}
}
