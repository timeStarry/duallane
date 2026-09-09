package interactions

import (
	"context"
	"errors"
	"time"
)

func (tx *interactionFakeTx) FinalizeCommandRun(_ context.Context, id string, resultJSON []byte, at time.Time) (*CommandRunRecord, bool, error) {
	for key, run := range tx.state.commands {
		if run.ID != id {
			continue
		}
		if run.Status != "succeeded" || run.ResultFinalizedAt != nil {
			return nil, false, nil
		}
		finalizedAt := at.UTC()
		run.ResultJSON = append([]byte(nil), resultJSON...)
		run.ResultFinalizedAt = &finalizedAt
		tx.state.commands[key] = run
		updated := cloneCommandRun(run)
		return &updated, true, nil
	}
	return nil, false, errors.New("command run missing")
}
