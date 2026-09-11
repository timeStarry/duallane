package files

import (
	"context"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type topicFileReader struct {
	*fakeFileRepo
	linked, visible bool
}

func (r topicFileReader) TopicAttachmentAccess(context.Context, string, string, string) (bool, bool, error) {
	return r.linked, r.visible, nil
}

func TestTopicAttachmentMembershipPrecedesStagingOwnership(t *testing.T) {
	for _, test := range []struct {
		name                            string
		linked, visible, uploader, want bool
	}{
		{"unsent staging remains private to uploader", false, false, true, true},
		{"unsent staging is not shared", false, false, false, false},
		{"joined reader can access linked topic attachment", true, true, false, true},
		{"unjoined reader cannot access linked topic attachment", true, false, false, false},
		{"removed uploader cannot bypass topic membership", true, false, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			repo := topicFileReader{fakeFileRepo: newFakeFileRepo(), linked: test.linked, visible: test.visible}
			service := NewService(ServiceOptions{Repository: repo})
			actor := &auth.Actor{ID: "reader", Kind: "human", Role: "owner"}
			uploader := "other"
			if test.uploader {
				uploader = actor.ID
			}
			visible, _, err := service.attachmentVisible(context.Background(), repo, actor, AttachmentRecord{ID: "file", SpaceID: DefaultSpaceID, UploaderID: uploader, Status: "available", Visibility: "private_staging"})
			if err != nil || visible != test.want {
				t.Fatalf("visible=%v error=%v, want %v", visible, err, test.want)
			}
		})
	}
}
