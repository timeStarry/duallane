package media

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestProcessorDeadlineWhileWaitingForBoundedSlot(t *testing.T) {
	processor := &Processor{
		options: DefaultOptions(),
		slots:   make(chan struct{}, 1),
	}
	processor.slots <- struct{}{}

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	_, err := processor.Process(ctx, encodePNG(t, 2, 2), Source{Kind: KindAvatar, MIMEType: "image/png"})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Process() error = %v, want context deadline", err)
	}

	<-processor.slots
	if err := processor.acquire(context.Background()); err != nil {
		t.Fatalf("acquire() after deadline = %v", err)
	}
	processor.release()
	if len(processor.slots) != 0 {
		t.Fatalf("slot count after deadline/reuse = %d, want 0", len(processor.slots))
	}
}

func TestProcessorSlotsBoundConcurrentWorkAndReleaseAllWaiters(t *testing.T) {
	processor := &Processor{slots: make(chan struct{}, 2)}
	const workers = 8
	start := make(chan struct{})
	release := make(chan struct{})
	acquired := make(chan struct{}, workers)
	var wait sync.WaitGroup
	wait.Add(workers)
	for range workers {
		go func() {
			defer wait.Done()
			<-start
			if err := processor.acquire(context.Background()); err != nil {
				t.Errorf("acquire() error = %v", err)
				return
			}
			acquired <- struct{}{}
			<-release
			processor.release()
		}()
	}
	close(start)

	deadline := time.After(time.Second)
	for len(acquired) < cap(processor.slots) {
		select {
		case <-deadline:
			t.Fatalf("only %d workers acquired a bounded slot", len(acquired))
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if got := len(processor.slots); got != cap(processor.slots) {
		t.Fatalf("active slots = %d, want cap %d", got, cap(processor.slots))
	}

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	if err := processor.acquire(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("third acquire() error = %v, want context deadline", err)
	}
	close(release)
	wait.Wait()
	if got := len(processor.slots); got != 0 {
		t.Fatalf("active slots after all releases = %d, want 0", got)
	}
}

func TestProcessorReleasesSlotAfterNativeFailure(t *testing.T) {
	processor := newTestProcessor(t)
	input := encodePNG(t, 2, 2)
	input = input[:33] // complete PNG header/IHDR, but no image data
	_, err := processor.Process(context.Background(), input, Source{Kind: KindAvatar, MIMEType: "image/png"})
	if err == nil {
		t.Fatal("Process() accepted a PNG with no image data")
	}
	if got := len(processor.slots); got != 0 {
		t.Fatalf("active slots after native failure = %d, want 0", got)
	}
}

func TestProcessorRejectsOutputOverageAfterFallback(t *testing.T) {
	options := DefaultOptions()
	options.CustomEmote.MaxOutputBytes = 1
	processor, err := NewProcessor(options)
	if err != nil {
		var mediaErr *Error
		if errors.As(err, &mediaErr) && mediaErr.Code == CodeProcessingUnavailable {
			t.Skipf("libvips unavailable: %v", mediaErr.Message)
		}
		t.Fatalf("NewProcessor() error = %v", err)
	}
	_, err = processor.ProcessCustomEmote(context.Background(), encodePNG(t, 48, 32), "image/png")
	var mediaErr *Error
	if !errors.As(err, &mediaErr) || mediaErr.Code != "emote.output_too_large" {
		t.Fatalf("output overage error = %v, want emote.output_too_large", err)
	}
	if mediaErr.Message != "压缩后的表情仍然过大" || mediaErr.StatusCode != 400 {
		t.Fatalf("output overage public diagnostic = %#v", mediaErr.Public())
	}
	if got := len(processor.slots); got != 0 {
		t.Fatalf("active slots after output overage = %d, want 0", got)
	}
}
