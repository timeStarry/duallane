package realtime

import "testing"

func TestHubCoalescesHintsAndUnsubscribes(t *testing.T) {
	hub := NewHub()
	first, unsubscribeFirst := hub.Subscribe()
	second, unsubscribeSecond := hub.Subscribe()
	if hub.SubscriberCount() != 2 {
		t.Fatalf("subscribers = %d", hub.SubscriberCount())
	}
	hub.Notify()
	hub.Notify()
	for name, channel := range map[string]<-chan struct{}{"first": first, "second": second} {
		select {
		case <-channel:
		default:
			t.Fatalf("%s subscriber did not receive hint", name)
		}
		select {
		case <-channel:
			t.Fatalf("%s subscriber received duplicate queued hint", name)
		default:
		}
	}
	unsubscribeFirst()
	unsubscribeFirst()
	unsubscribeSecond()
	if hub.SubscriberCount() != 0 {
		t.Fatalf("subscribers after cleanup = %d", hub.SubscriberCount())
	}
}
