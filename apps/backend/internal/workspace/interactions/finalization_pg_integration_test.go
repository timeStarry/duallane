//go:build postgres_integration

package interactions

import (
	"context"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func newPGReleaseFinalizationService(t *testing.T, fixture *pgInteractionIntegrationFixture) {
	t.Helper()
	commands, err := NewCommandRegistry(CommandDefinition{
		Name:     "release",
		Contexts: []CommandContext{CommandContextDirect, CommandContextMention},
		Execute: func(context.Context, CommandExecution) (CommandResult, error) {
			return CommandResult{Result: map[string]any{
				"type":           "release-published",
				"recipientCount": 1,
				"sentCount":      0,
				"failedCount":    0,
				"skippedCount":   0,
				"pendingCount":   1,
			}}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	repository, ok := fixture.service.repo.(*PGRepository)
	if !ok {
		t.Fatal("interaction fixture repository is not PostgreSQL")
	}
	fixture.service = NewService(ServiceOptions{
		Repository:      repository,
		CommandRegistry: commands,
		SpaceID:         DefaultSpaceID,
		Now:             func() time.Time { return fixture.now },
		IDFactory:       repository.idFactory,
	})
}

func releaseFinalizationCommand(invocationID string) ExecuteCommandInput {
	return ExecuteCommandInput{
		ActorID:            "usr_interaction_owner",
		SpaceID:            DefaultSpaceID,
		ConversationID:     "conv-interactions",
		BotUserID:          "usr_interaction_bot",
		Source:             "/release v1",
		MentionedBotIDs:    []string{"usr_interaction_bot"},
		ClientInvocationID: invocationID,
		Request:            Request{Meta: authRequestMeta("release-finalization")},
	}
}

func TestPGFinalizeCommandResultFreezesReleaseAndReplay(t *testing.T) {
	fixture := newPGInteractionIntegrationFixture(t)
	newPGReleaseFinalizationService(t, fixture)
	input := releaseFinalizationCommand("release-finalize-freeze")

	original, err := fixture.service.ExecuteCommand(fixture.ctx, input)
	if err != nil || !original.OK || original.Replayed || original.ResultFinalized {
		t.Fatalf("original = %#v, err=%v", original, err)
	}
	result := map[string]any{
		"type":           "release-published",
		"recipientCount": 1,
		"sentCount":      1,
		"failedCount":    0,
		"skippedCount":   0,
		"pendingCount":   0,
	}
	frozen, err := fixture.service.FinalizeCommandResult(fixture.ctx, FinalizeCommandResultInput{Execution: input, Original: original, Result: result})
	if err != nil || !frozen.OK || frozen.Replayed || !frozen.ResultFinalized {
		t.Fatalf("frozen = %#v, err=%v", frozen, err)
	}
	if !reflect.DeepEqual(canonicalJSON(frozen.Result), canonicalJSON(result)) {
		t.Fatalf("frozen result = %#v, want %#v", frozen.Result, result)
	}

	run, err := fixture.service.repo.GetCommandRun(fixture.ctx, DefaultSpaceID, input.ActorID, input.ClientInvocationID)
	if err != nil || run == nil || run.ResultFinalizedAt == nil {
		t.Fatalf("run after finalization = %#v, err=%v", run, err)
	}
	finalizedAt := *run.ResultFinalizedAt

	replayed, err := fixture.service.ExecuteCommand(fixture.ctx, input)
	if err != nil || !replayed.OK || !replayed.Replayed || !replayed.ResultFinalized {
		t.Fatalf("replayed = %#v, err=%v", replayed, err)
	}
	if !reflect.DeepEqual(canonicalJSON(replayed.Result), canonicalJSON(frozen.Result)) {
		t.Fatalf("replayed result = %#v, want frozen %#v", replayed.Result, frozen.Result)
	}

	changed, err := fixture.service.FinalizeCommandResult(fixture.ctx, FinalizeCommandResultInput{
		Execution: input,
		Original:  original,
		Result:    strings.Repeat("x", 17*1024),
	})
	if err != nil || !changed.ResultFinalized || !reflect.DeepEqual(canonicalJSON(changed.Result), canonicalJSON(frozen.Result)) {
		t.Fatalf("second finalization = %#v, err=%v", changed, err)
	}
	run, err = fixture.service.repo.GetCommandRun(fixture.ctx, DefaultSpaceID, input.ActorID, input.ClientInvocationID)
	if err != nil || run == nil || run.ResultFinalizedAt == nil || !run.ResultFinalizedAt.Equal(finalizedAt) {
		t.Fatalf("run changed after frozen replay = %#v, err=%v", run, err)
	}
}

func TestPGFinalizeCommandResultRejectsMismatchesAndInactiveAuthority(t *testing.T) {
	fixture := newPGInteractionIntegrationFixture(t)
	newPGReleaseFinalizationService(t, fixture)
	input := releaseFinalizationCommand("release-finalize-reject")
	original, err := fixture.service.ExecuteCommand(fixture.ctx, input)
	if err != nil {
		t.Fatal(err)
	}

	wrongOriginal := original
	wrongOriginal.Result = map[string]any{"type": "forged-original"}
	if _, err := fixture.service.FinalizeCommandResult(fixture.ctx, FinalizeCommandResultInput{Execution: input, Original: wrongOriginal, Result: map[string]any{"sentCount": 1}}); err == nil {
		t.Fatal("wrong original result finalized a run")
	}
	assertPGCommandResultUnfinalized(t, fixture, input.ClientInvocationID)

	wrongInput := input
	wrongInput.Source = "/release forged"
	if _, err := fixture.service.FinalizeCommandResult(fixture.ctx, FinalizeCommandResultInput{Execution: wrongInput, Original: original, Result: map[string]any{"sentCount": 1}}); err == nil {
		t.Fatal("request hash mismatch finalized a run")
	}
	assertPGCommandResultUnfinalized(t, fixture, input.ClientInvocationID)

	if _, err := fixture.service.FinalizeCommandResult(fixture.ctx, FinalizeCommandResultInput{Execution: input, Original: original, Result: strings.Repeat("x", 17*1024)}); err == nil {
		t.Fatal("unsafe generated result finalized a run")
	}
	assertPGCommandResultUnfinalized(t, fixture, input.ClientInvocationID)

	wrongActor := input
	wrongActor.ActorID = "usr_interaction_member"
	if _, err := fixture.service.FinalizeCommandResult(fixture.ctx, FinalizeCommandResultInput{Execution: wrongActor, Original: original, Result: map[string]any{"sentCount": 1}}); err == nil {
		t.Fatal("different actor finalized another actor's run")
	}
	assertPGCommandResultUnfinalized(t, fixture, input.ClientInvocationID)

	if _, err := fixture.pool.Exec(fixture.ctx, `UPDATE space_members SET removed_at = $1 WHERE space_id = $2 AND user_id = $3`, fixture.now, DefaultSpaceID, input.ActorID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.FinalizeCommandResult(fixture.ctx, FinalizeCommandResultInput{Execution: input, Original: original, Result: map[string]any{"sentCount": 1}}); err == nil {
		t.Fatal("inactive actor finalized a run")
	}
	assertPGCommandResultUnfinalized(t, fixture, input.ClientInvocationID)
}

func TestPGFinalizeCommandResultRejectsReleaseIdentityAndUnsafeCounts(t *testing.T) {
	fixture := newPGInteractionIntegrationFixture(t)
	newPGReleaseFinalizationService(t, fixture)
	input := releaseFinalizationCommand("release-finalize-result-validation")
	original, err := fixture.service.ExecuteCommand(fixture.ctx, input)
	if err != nil || !original.OK {
		t.Fatalf("original = %#v, err=%v", original, err)
	}

	for _, test := range []struct {
		name   string
		mutate func(map[string]any)
	}{
		{name: "wrong type", mutate: func(result map[string]any) { result["type"] = "release-other" }},
		{name: "identity field", mutate: func(result map[string]any) { result["identity"] = "forged" }},
		{name: "winner field", mutate: func(result map[string]any) { result["winner"] = 1 }},
		{name: "negative count", mutate: func(result map[string]any) { result["sentCount"] = int64(-1) }},
		{name: "fractional count", mutate: func(result map[string]any) { result["sentCount"] = 0.5 }},
		{name: "inconsistent counts", mutate: func(result map[string]any) { result["pendingCount"] = int64(2) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			candidate := clonePGFinalizationObject(t, original.Result)
			test.mutate(candidate)
			if _, err := fixture.service.FinalizeCommandResult(fixture.ctx, FinalizeCommandResultInput{Execution: input, Original: original, Result: candidate}); err == nil {
				t.Fatalf("invalid %s result was finalized: %#v", test.name, candidate)
			}
			assertPGCommandResultUnfinalized(t, fixture, input.ClientInvocationID)
		})
	}
}

func TestPGFinalizeCommandResultSerializesConcurrentWriters(t *testing.T) {
	fixture := newPGInteractionIntegrationFixture(t)
	newPGReleaseFinalizationService(t, fixture)
	input := releaseFinalizationCommand("release-finalize-concurrent")
	original, err := fixture.service.ExecuteCommand(fixture.ctx, input)
	if err != nil {
		t.Fatal(err)
	}

	const writers = 8
	start := make(chan struct{})
	type finalizationResult struct {
		candidate map[string]any
		outcome   CommandOutcome
		err       error
	}
	results := make(chan finalizationResult, writers)
	var wait sync.WaitGroup
	for i := 0; i < writers; i++ {
		wait.Add(1)
		go func(writer int) {
			defer wait.Done()
			<-start
			candidate := map[string]any{
				"type":           "release-published",
				"recipientCount": int64(1),
				"sentCount":      int64(0),
				"failedCount":    int64(0),
				"skippedCount":   int64(0),
				"pendingCount":   int64(0),
			}
			if writer%2 == 0 {
				candidate["sentCount"] = int64(1)
			} else {
				candidate["failedCount"] = int64(1)
			}
			outcome, err := fixture.service.FinalizeCommandResult(fixture.ctx, FinalizeCommandResultInput{
				Execution: input,
				Original:  original,
				Result:    candidate,
			})
			results <- finalizationResult{candidate: candidate, outcome: outcome, err: err}
		}(i)
	}
	close(start)
	wait.Wait()
	close(results)

	var winnerResult any
	variants := make(map[string]bool)
	for result := range results {
		if result.err != nil {
			t.Fatalf("concurrent finalization error: %v", result.err)
		}
		if !result.outcome.OK || !result.outcome.ResultFinalized {
			t.Fatalf("concurrent finalization outcome = %#v", result.outcome)
		}
		if winnerResult == nil {
			winnerResult = result.outcome.Result
		} else if !reflect.DeepEqual(canonicalJSON(result.outcome.Result), canonicalJSON(winnerResult)) {
			t.Fatalf("concurrent result changed: got %#v, first %#v", result.outcome.Result, winnerResult)
		}
		variants[string(canonicalJSON(result.candidate))] = true
	}
	if len(variants) != 2 {
		t.Fatalf("concurrent writers did not exercise two legal count snapshots: %d", len(variants))
	}

	run, err := fixture.service.repo.GetCommandRun(fixture.ctx, DefaultSpaceID, input.ActorID, input.ClientInvocationID)
	if err != nil || run == nil || run.ResultFinalizedAt == nil {
		t.Fatalf("concurrent run = %#v, err=%v", run, err)
	}
	if got := pgInteractionCount(t, fixture, `SELECT COUNT(*) FROM workspace_command_runs WHERE client_invocation_id = $1 AND result_finalized_at IS NOT NULL`, input.ClientInvocationID); got != 1 {
		t.Fatalf("finalized run count = %d", got)
	}
}

func clonePGFinalizationObject(t *testing.T, value any) map[string]any {
	t.Helper()
	object, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("finalization result = %#v, want object", value)
	}
	clone := make(map[string]any, len(object))
	for key, child := range object {
		clone[key] = child
	}
	return clone
}

func assertPGCommandResultUnfinalized(t *testing.T, fixture *pgInteractionIntegrationFixture, invocationID string) {
	t.Helper()
	var finalizedAt *time.Time
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT result_finalized_at FROM workspace_command_runs WHERE client_invocation_id = $1`, invocationID).Scan(&finalizedAt); err != nil {
		t.Fatal(err)
	}
	if finalizedAt != nil {
		t.Fatalf("result_finalized_at = %v, want NULL", *finalizedAt)
	}
}
