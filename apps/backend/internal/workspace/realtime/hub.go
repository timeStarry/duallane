package realtime

import "sync"

// Hub broadcasts database wake-up hints. Its channels carry no event payload:
// every consumer must recover authoritative rows from durable storage.
type Hub struct {
	mu          sync.Mutex
	subscribers map[chan struct{}]struct{}
}

func NewHub() *Hub {
	return &Hub{subscribers: make(map[chan struct{}]struct{})}
}

func (h *Hub) Subscribe() (<-chan struct{}, func()) {
	if h == nil {
		return nil, func() {}
	}
	channel := make(chan struct{}, 1)
	h.mu.Lock()
	if h.subscribers == nil {
		h.subscribers = make(map[chan struct{}]struct{})
	}
	h.subscribers[channel] = struct{}{}
	h.mu.Unlock()
	var once sync.Once
	return channel, func() {
		once.Do(func() {
			h.mu.Lock()
			delete(h.subscribers, channel)
			h.mu.Unlock()
		})
	}
}

func (h *Hub) Notify() {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for channel := range h.subscribers {
		select {
		case channel <- struct{}{}:
		default:
		}
	}
}

func (h *Hub) SubscriberCount() int {
	if h == nil {
		return 0
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subscribers)
}
