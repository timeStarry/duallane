package conversations

// MainTimelineVisibleMessageSQL scopes m to the viewer's main timeline. The
// caller binds its space and conversation and supplies cm.user_id as the viewer.
const MainTimelineVisibleMessageSQL = `m.deleted_at IS NULL
	AND m.topic_id IS NULL
	AND (m.thread_root_id IS NULL OR m.also_send_to_channel = TRUE)
	AND NOT EXISTS (
		SELECT 1 FROM message_hidden_states h
		WHERE h.message_id = m.id AND h.user_id = cm.user_id
	)`

// TimelineUnreadSQL projects one snapshot for bootstrap, conversation reads,
// and realtime. Creation order is stable even when a late commit carries an
// earlier timestamp. Markers from before event cursors use the history order.
// The caller binds $1 to the space and supplies cm as the viewer's member row.
const TimelineUnreadSQL = `
	SELECT COUNT(*) AS count,
		(array_agg(m.id ORDER BY m.created_at, m.id))[1] AS first_message_id
	FROM messages m
	LEFT JOIN messages marker ON marker.id = cm.last_read_message_id
		AND marker.space_id = $1 AND marker.conversation_id = cm.conversation_id
	LEFT JOIN (
		SELECT DISTINCT we.target_id FROM workspace_events we
		WHERE we.space_id = $1 AND we.conversation_id = cm.conversation_id
			AND we.type = 'message.created' AND we.seq > cm.last_read_seq
	) after_read ON after_read.target_id = m.id
	WHERE m.space_id = $1 AND m.conversation_id = cm.conversation_id
		AND ` + MainTimelineVisibleMessageSQL + `
		AND m.recalled_at IS NULL AND m.kind <> 'system'
		AND m.author_id IS DISTINCT FROM cm.user_id
		AND CASE WHEN cm.last_read_seq IS NOT NULL THEN after_read.target_id IS NOT NULL
			WHEN marker.id IS NOT NULL THEN (m.created_at, m.id) > (marker.created_at, marker.id)
			ELSE cm.last_read_at IS NULL OR m.created_at > cm.last_read_at
		END`
