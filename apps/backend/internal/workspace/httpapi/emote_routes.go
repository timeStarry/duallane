package httpapi

import (
	"context"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/emotes"
)

type emoteService interface {
	GetSettings(context.Context, string) (emotes.EmoteSettings, error)
	UpdateSettings(context.Context, string, emotes.UpdateSettingsInput, auth.RequestMeta) (emotes.EmoteSettings, error)
	List(context.Context, string) ([]emotes.CustomEmote, emotes.EmoteUsage, emotes.EmoteLimits, error)
	GetLibrary(context.Context, string) (emotes.PublicLibrary, error)
	Upload(context.Context, emotes.UploadInput) (*emotes.CustomEmote, error)
	CheckUploadLength(context.Context, string, int64, auth.RequestMeta) error
	FavoriteFromMessage(context.Context, emotes.FavoriteFromMessageInput) (*emotes.CustomEmote, error)
	CreateBuiltinFavorite(context.Context, string, string, auth.RequestMeta) (*emotes.CustomEmote, error)
	CreateCollection(context.Context, emotes.CreateCollectionInput) (emotes.Collection, error)
	UpdateCollection(context.Context, emotes.UpdateCollectionInput) (emotes.Collection, error)
	UpdateCollectionSourceSubscription(context.Context, string, string, bool, auth.RequestMeta) error
	DeleteCollection(context.Context, emotes.DeleteCollectionInput) (map[string]any, error)
	AddCollectionItems(context.Context, emotes.CollectionItemsInput) (emotes.Collection, error)
	RemoveCollectionItem(context.Context, emotes.RemoveCollectionItemInput) (emotes.Collection, error)
	ReorderLibrary(context.Context, emotes.ReorderInput) (emotes.PublicLibrary, error)
	ReorderEmotes(context.Context, emotes.ReorderInput) (emotes.PublicLibrary, error)
	ReorderCollection(context.Context, emotes.ReorderInput, string) (emotes.Collection, error)
	Update(context.Context, emotes.UpdateEmoteInput) (*emotes.CustomEmote, error)
	Remove(context.Context, string, string, auth.RequestMeta) (map[string]any, error)
	ReadContent(context.Context, emotes.ReadContentInput) (emotes.Delivery, error)
	CreateShare(context.Context, emotes.CreateShareInput) (emotes.Share, error)
	GetShare(context.Context, string, string) (emotes.Share, error)
	RevokeShare(context.Context, emotes.ShareInput) (emotes.Share, error)
	ImportShare(context.Context, emotes.ImportShareInput) (emotes.ImportShareResult, error)
}

type emoteSettingsRequest struct {
	EnabledPackIDs        optional[[]string] `json:"enabledPackIds"`
	ClickImageEmoteToSend optional[bool]     `json:"clickImageEmoteToSend"`
	ReplyAutoMention      optional[bool]     `json:"replyAutoMention"`
}

type emoteIDsRequest struct {
	EmoteIDs []string `json:"emoteIds"`
	EntryIDs []string `json:"entryIds"`
}

type emoteCollectionRequest struct {
	Name     string   `json:"name"`
	EmoteIDs []string `json:"emoteIds"`
}

type emoteSubscriptionRequest struct {
	Enabled optional[bool] `json:"enabled"`
}

type emoteImportRequest struct {
	EmoteIDs                 []string       `json:"emoteIds"`
	AsCollection             optional[bool] `json:"asCollection"`
	CollectionName           string         `json:"collectionName"`
	SubscribeToSourceChanges bool           `json:"subscribeToSourceChanges"`
}

type emoteFavoriteRequest struct {
	MessageID     string `json:"messageId"`
	AttachmentID  string `json:"attachmentId"`
	EmoteKey      string `json:"emoteKey"`
	CustomEmoteID string `json:"customEmoteId"`
}

func registerEmoteRoutes(router chi.Router, options RouterOptions) {
	router.Get("/me/emote-settings", withActor(options, getEmoteSettings))
	router.Put("/me/emote-settings", withActor(options, updateEmoteSettings))
	router.Get("/me/emotes", withActor(options, listEmotes))
	router.Get("/me/emote-library", withActor(options, getEmoteLibrary))
	router.Post("/me/emotes", withActor(options, uploadEmote))
	router.Post("/me/emotes/favorite", withActor(options, favoriteEmote))
	router.Put("/me/emote-library/order", withActor(options, reorderEmoteLibrary))
	router.Put("/me/emotes/order", withActor(options, reorderEmotes))
	router.Patch("/me/emotes/{emoteId}", withActor(options, updateEmote))
	router.Delete("/me/emotes/{emoteId}", withActor(options, removeEmote))
	router.Post("/me/emote-collections", withActor(options, createEmoteCollection))
	router.Patch("/me/emote-collections/{collectionId}", withActor(options, updateEmoteCollection))
	router.Put("/me/emote-collections/{collectionId}/source-subscription", withActor(options, updateEmoteSubscription))
	router.Delete("/me/emote-collections/{collectionId}", withActor(options, deleteEmoteCollection))
	router.Post("/me/emote-collections/{collectionId}/items", withActor(options, addEmoteCollectionItems))
	router.Delete("/me/emote-collections/{collectionId}/items/{emoteId}", withActor(options, removeEmoteCollectionItem))
	router.Put("/me/emote-collections/{collectionId}/order", withActor(options, reorderEmoteCollection))
	router.Post("/me/emote-collections/{collectionId}/shares", withActor(options, createEmoteShare))
	router.Delete("/me/emote-collection-shares/{shareId}", withActor(options, revokeEmoteShare))
	router.Get("/emote-collection-shares/{shareId}", withActor(options, getEmoteShare))
	router.Post("/emote-collection-shares/{shareId}/import", withActor(options, importEmoteShare))
	router.Get("/emotes/{emoteId}/content", withActor(options, getEmoteContent))
}

func getEmoteSettings(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(w, options.Emotes) {
		return
	}
	result, err := options.Emotes.GetSettings(r.Context(), actor.ID)
	writeResult(w, http.StatusOK, map[string]any{"settings": result}, err)
}

func updateEmoteSettings(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(w, options.Emotes) {
		return
	}
	var body emoteSettingsRequest
	if !decodeBody(w, r, &body) {
		return
	}
	result, err := options.Emotes.UpdateSettings(r.Context(), actor.ID, emotes.UpdateSettingsInput{
		EnabledPackIDs: body.EnabledPackIDs.Value, ClickImageEmoteToSend: body.ClickImageEmoteToSend.Value,
		ReplyAutoMention: body.ReplyAutoMention.Value,
	}, requestMeta(r, options))
	writeResult(w, http.StatusOK, map[string]any{"settings": result}, err)
}

func listEmotes(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(w, options.Emotes) {
		return
	}
	items, usage, limits, err := options.Emotes.List(r.Context(), actor.ID)
	writeResult(w, http.StatusOK, map[string]any{"emotes": items, "usage": usage, "limits": limits}, err)
}

func getEmoteLibrary(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(w, options.Emotes) {
		return
	}
	result, err := options.Emotes.GetLibrary(r.Context(), actor.ID)
	writeResult(w, http.StatusOK, result, err)
}

func uploadEmote(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(w, options.Emotes) {
		return
	}
	if r.ContentLength > emotes.MaxInputBytes {
		writeError(w, options.Emotes.CheckUploadLength(r.Context(), actor.ID, r.ContentLength, requestMeta(r, options)))
		return
	}
	fileName, err := decodeEmoteFileName(r.Header.Get("X-DualLane-File-Name"))
	if err != nil {
		writeError(w, err)
		return
	}
	contentType := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Type")))
	if mediaType, _, parseErr := mime.ParseMediaType(contentType); parseErr == nil {
		contentType = mediaType
	}
	result, uploadErr := options.Emotes.Upload(r.Context(), emotes.UploadInput{
		ActorID: actor.ID, Content: io.LimitReader(r.Body, emotes.MaxInputBytes+1),
		Source:       emotes.UploadSource{Type: "upload", FileName: fileName, MIMEType: contentType},
		CollectionID: strings.TrimSpace(r.URL.Query().Get("collectionId")),
		AddToLibrary: r.URL.Query().Get("addToLibrary") != "false", Meta: requestMeta(r, options),
	})
	writeResult(w, http.StatusCreated, map[string]any{"emote": result}, uploadErr)
}

func favoriteEmote(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(w, options.Emotes) {
		return
	}
	var body emoteFavoriteRequest
	if !decodeBody(w, r, &body) {
		return
	}
	result, err := options.Emotes.FavoriteFromMessage(r.Context(), emotes.FavoriteFromMessageInput{
		ActorID: actor.ID, MessageID: body.MessageID, AttachmentID: body.AttachmentID,
		EmoteKey: body.EmoteKey, CustomEmoteID: body.CustomEmoteID,
		Meta: requestMeta(r, options),
	})
	writeResult(w, http.StatusCreated, map[string]any{"emote": result}, err)
}

func reorderEmoteLibrary(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	var body emoteIDsRequest
	if missingService(w, options.Emotes) || !decodeBody(w, r, &body) {
		return
	}
	result, err := options.Emotes.ReorderLibrary(r.Context(), emotes.ReorderInput{ActorID: actor.ID, IDs: body.EntryIDs, Meta: requestMeta(r, options)})
	writeResult(w, http.StatusOK, result, err)
}

func reorderEmotes(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	var body emoteIDsRequest
	if missingService(w, options.Emotes) || !decodeBody(w, r, &body) {
		return
	}
	result, err := options.Emotes.ReorderEmotes(r.Context(), emotes.ReorderInput{ActorID: actor.ID, IDs: body.EmoteIDs, Meta: requestMeta(r, options)})
	writeResult(w, http.StatusOK, result, err)
}

func createEmoteCollection(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	var body emoteCollectionRequest
	if missingService(w, options.Emotes) || !decodeBody(w, r, &body) {
		return
	}
	result, err := options.Emotes.CreateCollection(r.Context(), emotes.CreateCollectionInput{ActorID: actor.ID, Name: body.Name, EmoteIDs: body.EmoteIDs, Meta: requestMeta(r, options)})
	writeResult(w, http.StatusCreated, map[string]any{"collection": result}, err)
}

func updateEmoteCollection(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	var body emoteCollectionRequest
	if missingService(w, options.Emotes) || !decodeBody(w, r, &body) {
		return
	}
	result, err := options.Emotes.UpdateCollection(r.Context(), emotes.UpdateCollectionInput{ActorID: actor.ID, CollectionID: chi.URLParam(r, "collectionId"), Name: body.Name, Meta: requestMeta(r, options)})
	writeResult(w, http.StatusOK, map[string]any{"collection": result}, err)
}

func updateEmoteSubscription(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	var body emoteSubscriptionRequest
	if missingService(w, options.Emotes) || !decodeBody(w, r, &body) {
		return
	}
	if !body.Enabled.Set || body.Enabled.Value == nil {
		writeError(w, emotes.NewError(emotes.CodeEmoteInvalidSubscription, emotes.MessageEmoteInvalidSubscription, http.StatusBadRequest))
		return
	}
	collectionID := chi.URLParam(r, "collectionId")
	if err := options.Emotes.UpdateCollectionSourceSubscription(r.Context(), actor.ID, collectionID, *body.Enabled.Value, requestMeta(r, options)); err != nil {
		writeError(w, err)
		return
	}
	library, err := options.Emotes.GetLibrary(r.Context(), actor.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	var collection *emotes.Collection
	for index := range library.Collections {
		if library.Collections[index].ID == collectionID {
			collection = &library.Collections[index]
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"collection": collection, "library": library})
}

func deleteEmoteCollection(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(w, options.Emotes) {
		return
	}
	disposition := "keep"
	if r.URL.Query().Get("itemDisposition") == "remove" {
		disposition = "remove"
	}
	result, err := options.Emotes.DeleteCollection(r.Context(), emotes.DeleteCollectionInput{ActorID: actor.ID, CollectionID: chi.URLParam(r, "collectionId"), Disposition: disposition, Meta: requestMeta(r, options)})
	writeResult(w, http.StatusOK, result, err)
}

func addEmoteCollectionItems(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	var body emoteIDsRequest
	if missingService(w, options.Emotes) || !decodeBody(w, r, &body) {
		return
	}
	result, err := options.Emotes.AddCollectionItems(r.Context(), emotes.CollectionItemsInput{ActorID: actor.ID, CollectionID: chi.URLParam(r, "collectionId"), EmoteIDs: body.EmoteIDs, Meta: requestMeta(r, options)})
	writeResult(w, http.StatusOK, map[string]any{"collection": result}, err)
}

func removeEmoteCollectionItem(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(w, options.Emotes) {
		return
	}
	result, err := options.Emotes.RemoveCollectionItem(r.Context(), emotes.RemoveCollectionItemInput{ActorID: actor.ID, CollectionID: chi.URLParam(r, "collectionId"), EmoteID: chi.URLParam(r, "emoteId"), Meta: requestMeta(r, options)})
	writeResult(w, http.StatusOK, map[string]any{"collection": result}, err)
}

func reorderEmoteCollection(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	var body emoteIDsRequest
	if missingService(w, options.Emotes) || !decodeBody(w, r, &body) {
		return
	}
	result, err := options.Emotes.ReorderCollection(r.Context(), emotes.ReorderInput{ActorID: actor.ID, IDs: body.EmoteIDs, Meta: requestMeta(r, options)}, chi.URLParam(r, "collectionId"))
	writeResult(w, http.StatusOK, map[string]any{"collection": result}, err)
}

func createEmoteShare(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(w, options.Emotes) {
		return
	}
	result, err := options.Emotes.CreateShare(r.Context(), emotes.CreateShareInput{ActorID: actor.ID, CollectionID: chi.URLParam(r, "collectionId"), Meta: requestMeta(r, options)})
	writeResult(w, http.StatusCreated, map[string]any{"share": result}, err)
}

func revokeEmoteShare(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(w, options.Emotes) {
		return
	}
	result, err := options.Emotes.RevokeShare(r.Context(), emotes.ShareInput{ActorID: actor.ID, ShareID: chi.URLParam(r, "shareId"), Meta: requestMeta(r, options)})
	writeResult(w, http.StatusOK, map[string]any{"share": result}, err)
}

func getEmoteShare(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(w, options.Emotes) {
		return
	}
	result, err := options.Emotes.GetShare(r.Context(), actor.ID, chi.URLParam(r, "shareId"))
	writeResult(w, http.StatusOK, map[string]any{"share": result}, err)
}

func importEmoteShare(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	var body emoteImportRequest
	if missingService(w, options.Emotes) || !decodeBody(w, r, &body) {
		return
	}
	result, err := options.Emotes.ImportShare(r.Context(), emotes.ImportShareInput{ActorID: actor.ID, ShareID: chi.URLParam(r, "shareId"), EmoteIDs: body.EmoteIDs, AsCollection: body.AsCollection.Value, SubscribeToSourceChanges: body.SubscribeToSourceChanges, CollectionName: body.CollectionName, Meta: requestMeta(r, options)})
	writeResult(w, http.StatusOK, result, err)
}

func updateEmote(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	var body struct {
		Label string `json:"label"`
	}
	if missingService(w, options.Emotes) || !decodeBody(w, r, &body) {
		return
	}
	result, err := options.Emotes.Update(r.Context(), emotes.UpdateEmoteInput{ActorID: actor.ID, EmoteID: chi.URLParam(r, "emoteId"), Label: body.Label, Meta: requestMeta(r, options)})
	writeResult(w, http.StatusOK, map[string]any{"emote": result}, err)
}

func removeEmote(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(w, options.Emotes) {
		return
	}
	result, err := options.Emotes.Remove(r.Context(), actor.ID, chi.URLParam(r, "emoteId"), requestMeta(r, options))
	writeResult(w, http.StatusOK, result, err)
}

func getEmoteContent(w http.ResponseWriter, r *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(w, options.Emotes) {
		return
	}
	delivery, err := options.Emotes.ReadContent(r.Context(), emotes.ReadContentInput{ActorID: actor.ID, EmoteID: chi.URLParam(r, "emoteId"), MaxBytes: emotes.MaxOutputBytes, Meta: requestMeta(r, options)})
	if err != nil {
		writeError(w, err)
		return
	}
	defer delivery.Body.Close()
	w.Header().Set("Content-Type", "image/webp")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("Content-Disposition", "inline")
	if delivery.ByteSize >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(delivery.ByteSize, 10))
	}
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, io.LimitReader(delivery.Body, emotes.MaxOutputBytes+1))
}

func decodeEmoteFileName(value string) (string, error) {
	decoded, err := url.PathUnescape(value)
	if err != nil {
		return "", emotes.NewError(emotes.CodeEmoteInvalidFileName, emotes.MessageEmoteInvalidFileName, http.StatusBadRequest)
	}
	decoded = strings.TrimSpace(decoded)
	return decoded, nil
}
