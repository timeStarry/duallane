package httpapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/avatars"
)

// AvatarService is the transport-facing profile avatar boundary.
type AvatarService interface {
	SetOwnAvatar(context.Context, avatars.SetOwnAvatarInput) (avatars.AvatarMutationResult, error)
	RemoveOwnAvatar(context.Context, avatars.RemoveOwnAvatarInput) (avatars.AvatarMutationResult, error)
	OpenProfileAvatar(context.Context, avatars.GetProfileAvatarInput, int64) (platformstorage.OpenedObject, error)
}

// AvatarRouteOptions contains only the dependencies needed by the avatar
// routes. The workspace feature gate is expected to wrap the parent router;
// this function never creates a second gate or resolves client actor IDs.
type AvatarRouteOptions struct {
	Service       AvatarService
	ActorResolver ActorResolver
	TrustProxy    bool
}

// RegisterAvatarRoutes mounts paths relative to /api/workspace. The parent
// composition should call it inside the existing gated workspace route group.
func RegisterAvatarRoutes(router chi.Router, options AvatarRouteOptions) {
	if router == nil {
		return
	}
	router.Put("/me/avatar", func(response http.ResponseWriter, request *http.Request) {
		actor, ok := resolveActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		setOwnAvatarRoute(response, request, actor, options)
	})
	router.Delete("/me/avatar", func(response http.ResponseWriter, request *http.Request) {
		actor, ok := resolveActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		removeOwnAvatarRoute(response, request, actor, options)
	})
	router.Get("/avatars/{userId}/{version}", func(response http.ResponseWriter, request *http.Request) {
		actor, ok := resolveActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		getProfileAvatarRoute(response, request, actor, options)
	})
}

func setOwnAvatarRoute(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options AvatarRouteOptions) {
	if options.Service == nil {
		writeAvatarError(response, internalError())
		return
	}
	if request.ContentLength > avatars.AvatarMaxInputBytes {
		writeAvatarError(response, avatars.NewError(avatars.CodeAvatarInvalidSize, avatars.MessageAvatarInvalidSize, http.StatusBadRequest))
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, avatars.AvatarMaxInputBytes+1)
	content, err := io.ReadAll(request.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeAvatarError(response, avatars.NewError(avatars.CodeAvatarInvalidSize, avatars.MessageAvatarInvalidSize, http.StatusBadRequest))
			return
		}
		writeAvatarError(response, err)
		return
	}
	if int64(len(content)) > avatars.AvatarMaxInputBytes {
		writeAvatarError(response, avatars.NewError(avatars.CodeAvatarInvalidSize, avatars.MessageAvatarInvalidSize, http.StatusBadRequest))
		return
	}
	if request.ContentLength >= 0 && int64(len(content)) != request.ContentLength {
		writeAvatarError(response, avatars.NewError(avatars.CodeAvatarInvalidSize, avatars.MessageAvatarSizeMismatch, http.StatusBadRequest))
		return
	}
	result, err := options.Service.SetOwnAvatar(request.Context(), avatars.SetOwnAvatarInput{
		ActorID:  actor.ID,
		MIMEType: strings.ToLower(strings.TrimSpace(request.Header.Get("Content-Type"))),
		Content:  content,
		Meta:     auth.RequestMetaFromRequest(request, options.TrustProxy),
	})
	if err != nil {
		writeAvatarError(response, err)
		return
	}
	if result.User == nil {
		writeAvatarError(response, internalError())
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"user": auth.PublicActor(result.User)})
}

func removeOwnAvatarRoute(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options AvatarRouteOptions) {
	if options.Service == nil {
		writeAvatarError(response, internalError())
		return
	}
	result, err := options.Service.RemoveOwnAvatar(request.Context(), avatars.RemoveOwnAvatarInput{
		ActorID: actor.ID,
		Meta:    auth.RequestMetaFromRequest(request, options.TrustProxy),
	})
	if err != nil {
		writeAvatarError(response, err)
		return
	}
	if result.User == nil {
		writeAvatarError(response, internalError())
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"user": auth.PublicActor(result.User)})
}

func getProfileAvatarRoute(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options AvatarRouteOptions) {
	if options.Service == nil {
		writeAvatarError(response, internalError())
		return
	}
	opened, err := options.Service.OpenProfileAvatar(request.Context(), avatars.GetProfileAvatarInput{
		ActorID: actor.ID,
		UserID:  chi.URLParam(request, "userId"),
		Version: chi.URLParam(request, "version"),
	}, avatars.AvatarMaxOutputBytes)
	if err != nil {
		writeAvatarError(response, err)
		return
	}
	defer opened.Body.Close()
	response.Header().Set("Content-Type", avatars.AvatarContentType)
	response.Header().Set("Content-Disposition", "inline")
	response.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	if opened.ByteSize > 0 {
		response.Header().Set("Content-Length", strconv.FormatInt(opened.ByteSize, 10))
	}
	response.WriteHeader(http.StatusOK)
	_, _ = io.Copy(response, io.LimitReader(opened.Body, avatars.AvatarMaxOutputBytes))
}

func writeAvatarError(response http.ResponseWriter, err error) {
	value := internalError()
	var avatarError *avatars.Error
	var transportError *publicError
	switch {
	case errors.As(err, &avatarError) && avatarError != nil:
		status := avatarError.StatusCode
		if status <= 0 {
			status = http.StatusInternalServerError
		}
		value = &publicError{Code: avatarError.Code, Message: avatarError.Message, StatusCode: status}
	case errors.As(err, &transportError) && transportError != nil:
		value = transportError
	}
	writeJSON(response, value.StatusCode, map[string]any{"error": value})
}
