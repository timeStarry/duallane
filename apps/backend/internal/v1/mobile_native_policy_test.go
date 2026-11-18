package v1

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestPublicNativePolicyAllowsRecoveryAfterWithdrawal(t *testing.T) {
	r := chi.NewRouter()
	NewHTTPHandler(NewService(&stubRepo{}), nil).Mount(r)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/mobile/native-policy", nil)
	request.Header.Set("X-DualLane-Native-Version-Code", "0")
	response := httptest.NewRecorder()
	r.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" || !strings.Contains(response.Body.String(), `"minimumSupportedNativeVersionCode":0`) {
		t.Fatalf("withdrawn distribution recovery: %d %s", response.Code, response.Body.String())
	}
}

func TestAPKPublicationCannotInventANewerNativeIdentity(t *testing.T) {
	repo := &stubRepo{mobileRelease: MobileClientRelease{Enabled: true, Version: "1.0.14", VersionCode: 10055, MinimumSupportedNativeVersionCode: 10054}}
	blobs := &memBlobStore{}
	svc := NewService(repo).WithBlobStore(blobs)
	apk := buildSyntheticDualLaneAPK(t, "1.0.14", 10055)
	for _, override := range []struct {
		version string
		code    int
	}{
		{"1.0.14", 10100}, {"1.1.0", 10055}, {"1.1.0", 10100},
	} {
		_, err := svc.UploadAdminMobileAPK(context.Background(), "owner", apk, override.version, override.code)
		if !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("mismatched APK override accepted: %+v %v", override, err)
		}
	}
	_, err := svc.UploadAdminMobileAPK(context.Background(), "owner", buildSyntheticDualLaneAPK(t, "", 0), "1.1.0", 10100)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatal("missing native identity was replaced with guessed metadata")
	}
	var duplicate bytes.Buffer
	zw := zip.NewWriter(&duplicate)
	for _, entry := range []struct{ name, body string }{
		{"AndroidManifest.xml", "manifest"}, {"classes.dex", "dex"},
		{"assets/app.config", `{"version":"1.0.14","android":{"package":"com.timestarry.duallane","versionCode":10055}}`},
		{"assets/app.config", `{"version":"1.1.0","android":{"package":"com.timestarry.duallane","versionCode":10100}}`},
	} {
		w, _ := zw.Create(entry.name)
		_, _ = w.Write([]byte(entry.body))
	}
	_ = zw.Close()
	_, err = svc.UploadAdminMobileAPK(context.Background(), "owner", duplicate.Bytes(), "", 0)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatal("ambiguous duplicate packaged identity accepted")
	}
	if len(blobs.blobs) != 0 {
		t.Fatal("rejected APK override wrote a blob")
	}
	accepted, err := svc.UploadAdminMobileAPK(context.Background(), "owner", apk, "v1.0.14", 10055)
	if err != nil || accepted.VersionCode != 10055 || accepted.APKVersion != "1.0.14" {
		t.Fatalf("matching identity rejected: %+v %v", accepted, err)
	}
}

func TestNativeMinimumIsIndependentFromOTAFloorAndPreserved(t *testing.T) {
	repo := &stubRepo{mobileRelease: MobileClientRelease{
		Enabled: true, Version: "1.0.14", APKVersion: "1.0.14", VersionCode: 10055,
		SHA256: strings.Repeat("a", 64), ByteSize: 100,
		OTA: &MobileOTABundle{Enabled: true, Version: "1.0.14", MinNativeVersionCode: 10051, SHA256: strings.Repeat("b", 64), ByteSize: 50},
	}}
	svc := NewService(repo)
	minimum := 10054
	release, err := svc.UpdateAdminMobileRelease(context.Background(), "owner", MobileClientReleaseMetadataInput{Enabled: true, MinimumSupportedNativeVersionCode: &minimum})
	if err != nil {
		t.Fatal(err)
	}
	if release.MinimumSupportedNativeVersionCode != 10054 || release.OTA.MinNativeVersionCode != 10051 {
		t.Fatalf("floors conflated: %+v", release)
	}
	release, err = svc.UpdateAdminMobileRelease(context.Background(), "owner", MobileClientReleaseMetadataInput{Enabled: true, Notes: "note"})
	if err != nil || release.MinimumSupportedNativeVersionCode != 10054 {
		t.Fatalf("normal release edit removed floor: %+v %v", release, err)
	}
	for _, invalid := range []int{-1, 10056, 2100000001} {
		_, err = svc.UpdateAdminMobileRelease(context.Background(), "owner", MobileClientReleaseMetadataInput{Enabled: true, MinimumSupportedNativeVersionCode: &invalid})
		if !errors.Is(err, ErrInvalidInput) {
			t.Errorf("floor %d error=%v", invalid, err)
		}
	}
	forgedCode := 10100
	_, err = svc.UpdateAdminMobileRelease(context.Background(), "owner", MobileClientReleaseMetadataInput{Enabled: true, VersionCode: forgedCode, MinimumSupportedNativeVersionCode: &forgedCode})
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatal("metadata must not raise the APK version above the actual hosted APK")
	}
	_, err = svc.UpdateAdminMobileRelease(context.Background(), "owner", MobileClientReleaseMetadataInput{Enabled: false})
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatal("disabling APK while keeping mandatory floor must fail")
	}
	zero := 0
	release, err = svc.UpdateAdminMobileRelease(context.Background(), "owner", MobileClientReleaseMetadataInput{Enabled: false, MinimumSupportedNativeVersionCode: &zero})
	if err != nil || release.MinimumSupportedNativeVersionCode != 0 {
		t.Fatalf("explicit recovery policy reset failed: %v", err)
	}
}
